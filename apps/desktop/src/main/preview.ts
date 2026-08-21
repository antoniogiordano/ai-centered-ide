import { session, shell } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import {
  PREVIEW_CONSOLE_BUFFER_MAX,
  createEmptyPreviewStatus,
  describePreviewUrlRejection,
  fitPreviewViewport,
  isAllowedPreviewUrl,
  parseDevServerUrl,
  type ArchitectureDev,
  type PreviewElementSelection,
  type PreviewRect,
  type PreviewService,
  type PreviewSetup,
  type PreviewStatus,
  type PreviewViewportId,
} from "@ai-ide/shared";
import { ELEMENT_COLLECTOR } from "./preview-collector.js";
import {
  ArchitectureStore,
  detectDevScriptCandidates,
  devServicesFromArchitecture,
  PREVIEW_URL_WAIT_MS,
  waitForPreviewUrl,
} from "@ai-ide/workspace";

/**
 * The live preview surface. The page it shows is untrusted project output, so
 * it runs in its own session partition with no preload and no way to reach the
 * IDE bridge, and every navigation goes through the loopback allowlist here in
 * the main process (see docs/notes/browser-surface-spike-2026-07-31.md).
 *
 * The guest is a renderer `<webview>` that paints inside the preview hole.
 * Electron 36 on macOS keeps a WebContentsView behind the window's own
 * renderer, so a native overlay never becomes visible. Isolation still holds:
 * the guest has no preload, and this class is the only thing that may point
 * it at a URL.
 */

const PARTITION_PREFIX = "persist:preview-";
const SNIFF_BUFFER_MAX = 20_000;
/** The PTY writes an nvm/fnm bootstrap right after spawn; don't race it. */
const SERVICE_COMMAND_DELAY_MS = 700;
/** Chromium: the port was closed. Never paint this while wait-on is still polling. */
const ERR_CONNECTION_REFUSED = -102;

export type PreviewHost = {
  workspaceRoot: () => string | null;
  projectId: () => string | null;
  openTerminal: (opts: { cwd: string; title: string }) => { id: string };
  writeTerminal: (terminalId: string, text: string) => void;
  closeTerminal: (terminalId: string) => void;
  onTerminalData: (
    listener: (event: { terminalId: string; data: string }) => void,
  ) => () => void;
};

export type PreviewCapture = {
  dataBase64: string;
  mime: "image/png";
  width: number;
  height: number;
  url: string | null;
  viewRect: PreviewRect | null;
};

export class PreviewManager {
  private status: PreviewStatus = createEmptyPreviewStatus();
  private listeners = new Set<(status: PreviewStatus) => void>();
  private win: BrowserWindow | null = null;
  /** Guest page owned by the renderer `<webview>`; wired here for policy. */
  private guest: WebContents | null = null;
  private partition: string | null = null;
  private paneRect: PreviewRect | null = null;
  /** serviceId → terminalId, so stop() only kills what preview started. */
  private serviceTerminals = new Map<string, string>();
  /** terminalId → tail of output still being scanned for a server URL. */
  private sniffBuffers = new Map<string, string>();
  private unsubscribeTerminals: (() => void) | null = null;
  private loadToken = 0;
  private waitAbort: AbortController | null = null;
  /** Set when we know the target before the renderer webview exists. */
  private pendingUrl: string | null = null;
  private elementListeners = new Set<(hit: PreviewElementSelection) => void>();
  private debuggerAttached = false;
  /** Serialize start/stop so React Strict Mode cannot destroy a just-created view. */
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(private readonly host: PreviewHost) {}

  private enqueueLifecycle<T>(op: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(op, op);
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  onStatus(listener: (status: PreviewStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onElement(listener: (hit: PreviewElementSelection) => void): () => void {
    this.elementListeners.add(listener);
    return () => this.elementListeners.delete(listener);
  }

  getStatus(): PreviewStatus {
    return this.status;
  }

  attachWindow(win: BrowserWindow): void {
    this.win = win;
  }

  /**
   * The renderer just created the guest `<webview>`. From here on navigation,
   * DevTools, capture and the element picker talk to this WebContents.
   */
  attachGuest(wc: WebContents): void {
    if (this.partition) {
      const expected = session.fromPartition(this.partition, { cache: true });
      if (wc.session !== expected) return;
    }
    if (this.guest === wc) return;
    this.guest = wc;
    this.wireGuest(wc);
    wc.once("destroyed", () => {
      if (this.guest === wc) {
        this.detachDebugger();
        this.guest = null;
      }
    });
    const target = this.pendingUrl ?? this.status.url;
    if (target) void this.loadTarget(target);
    this.syncNavigationFlags();
  }

  /** Workspace changed: tear the surface down and re-answer "is this a web project?". */
  refreshWorkspace(): void {
    void this.stop();
    this.update({ supported: this.detectSupported(), error: null });
  }

  private detectSupported(): boolean {
    const root = this.host.workspaceRoot();
    if (!root) return false;
    return detectDevScriptCandidates(root).length > 0;
  }

  /**
   * Read the answer to "how do I run this project?" from
   * .aici/ARCHITECTURE.md. Nothing here falls back to a guess: an unanswered
   * project stops at `needs_command` and the human hands the question to the
   * agent, which is the only reader that can tell a wrapper from a server.
   */
  private readSetup(root: string): {
    setup: PreviewSetup;
    dev: ArchitectureDev | undefined;
  } {
    const candidates = detectDevScriptCandidates(root).map((candidate) => ({
      name: candidate.name,
      command: candidate.command,
      testVariant: candidate.testVariant,
    }));
    let dev: ArchitectureDev | undefined;
    let confirmed = false;
    try {
      const view = new ArchitectureStore(root).loadEffective();
      dev = view.effective.dev;
      confirmed = view.effective.meta.sources.dev === "user_confirmed";
    } catch {
      // A broken ARCHITECTURE.md is the architecture pane's problem to report.
    }
    return {
      dev,
      setup: {
        command: dev?.command ?? null,
        confirmed,
        supportCount: dev?.support?.length ?? 0,
        candidates,
      },
    };
  }

  /**
   * Re-read the profile while the pane waits for a command. The agent writes
   * ARCHITECTURE.md through its own tool, so this is how the preview notices.
   */
  refreshSetup(): void {
    const root = this.host.workspaceRoot();
    if (!root) return;
    if (
      this.status.phase !== "needs_command" &&
      this.status.phase !== "needs_confirm"
    ) {
      return;
    }
    const { setup } = this.readSetup(root);
    this.update({
      setup,
      phase: setup.command ? "needs_confirm" : "needs_command",
    });
  }

  /**
   * The human signs off on the agent's proposal. Promoting the source to
   * `user_confirmed` is what makes the answer stick for the next session.
   */
  async confirmSetup(): Promise<{ ok: boolean; error?: string }> {
    const root = this.host.workspaceRoot();
    if (!root) return { ok: false, error: "Open a workspace first." };
    const { dev } = this.readSetup(root);
    if (!dev?.command) {
      return {
        ok: false,
        error: "There is no proposed dev command to confirm.",
      };
    }
    try {
      new ArchitectureStore(root).savePatch({ dev }, "user_confirmed");
    } catch (error) {
      const message = `Could not write the dev command: ${describeError(error)}`;
      this.update({ error: message });
      return { ok: false, error: message };
    }
    await this.stop();
    return this.start();
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueLifecycle(() => this.startNow());
  }

  private async startNow(): Promise<{ ok: boolean; error?: string }> {
    const root = this.host.workspaceRoot();
    if (!root) {
      this.update({ error: "Open a workspace first.", phase: "error" });
      return { ok: false, error: "Open a workspace first." };
    }
    if (this.status.enabled) {
      this.ensurePartition();
      if (this.status.url) void this.loadTarget(this.status.url);
      this.applyBounds();
      this.applyVisibility();
      return { ok: true };
    }

    const { setup, dev } = this.readSetup(root);
    this.update({
      enabled: true,
      supported: setup.candidates.length > 0 || Boolean(setup.command),
      setup,
      services: [],
      error: null,
      url: null,
      consoleErrorCount: 0,
      recentConsole: [],
    });

    if (!setup.command) {
      this.update({ phase: "needs_command" });
      return { ok: true };
    }
    if (!setup.confirmed) {
      this.update({ phase: "needs_confirm" });
      return { ok: true };
    }

    const specs = devServicesFromArchitecture(dev);

    this.unsubscribeTerminals = this.host.onTerminalData((event) =>
      this.onTerminalData(event),
    );

    const services: PreviewService[] = specs.map((spec) => ({
      id: spec.id,
      name: spec.name,
      command: spec.command,
      role: spec.role,
      terminalId: null,
      status: "pending",
      url: null,
    }));

    this.update({ phase: "starting", services, visible: true });
    this.ensurePartition();

    for (const spec of specs) {
      try {
        const terminal = this.host.openTerminal({
          cwd: root,
          title: `dev · ${spec.name}`,
        });
        this.serviceTerminals.set(spec.id, terminal.id);
        this.patchService(spec.id, {
          terminalId: terminal.id,
          status: "starting",
        });
        const terminalId = terminal.id;
        const command = spec.command;
        setTimeout(() => {
          if (!this.serviceTerminals.has(spec.id)) return;
          try {
            this.host.writeTerminal(terminalId, `${command}\r`);
          } catch {
            this.patchService(spec.id, { status: "exited" });
          }
        }, SERVICE_COMMAND_DELAY_MS);
      } catch (error) {
        this.patchService(spec.id, { status: "exited" });
        this.update({
          error: `Could not start ${spec.name}: ${describeError(error)}`,
        });
      }
    }

    // A server that never prints its address can still be previewed, as long as
    // the profile says where to look. It gets a long runway because nothing here
    // can tell "still compiling" from "never coming up".
    const declaredUrl = dev?.url;
    if (declaredUrl) {
      if (!isAllowedPreviewUrl(declaredUrl)) {
        this.update({ error: describePreviewUrlRejection(declaredUrl) });
      } else {
        setTimeout(() => {
          if (!this.status.enabled || this.status.url) return;
          void this.loadTarget(declaredUrl);
        }, SERVICE_COMMAND_DELAY_MS);
      }
    }

    return { ok: true };
  }

  async stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopNow());
  }

  private async stopNow(): Promise<void> {
    this.loadToken += 1;
    this.waitAbort?.abort();
    this.waitAbort = null;
    this.unsubscribeTerminals?.();
    this.unsubscribeTerminals = null;
    for (const terminalId of this.serviceTerminals.values()) {
      try {
        this.host.closeTerminal(terminalId);
      } catch {
        /* already gone */
      }
    }
    this.serviceTerminals.clear();
    this.sniffBuffers.clear();
    this.pendingUrl = null;
    this.releaseGuest();
    this.update({
      enabled: false,
      phase: "off",
      services: [],
      url: null,
      viewRect: null,
      partition: null,
      visible: false,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      devtoolsOpen: false,
      picking: false,
      error: null,
    });
  }

  setPaneRect(rect: PreviewRect | null): void {
    this.paneRect = rect;
    this.applyBounds();
  }

  setVisible(visible: boolean): void {
    if (this.status.visible !== visible) this.update({ visible });
    this.applyVisibility();
  }

  setViewport(viewport: PreviewViewportId): void {
    this.update({ viewport });
    this.applyBounds();
  }

  async navigate(url: string): Promise<{ ok: boolean; error?: string }> {
    if (!isAllowedPreviewUrl(url)) {
      const error = describePreviewUrlRejection(url);
      this.update({ error });
      return { ok: false, error };
    }
    this.update({ error: null });
    await this.loadTarget(url);
    return { ok: true };
  }

  async act(
    action: "back" | "forward" | "reload" | "stop",
  ): Promise<{ ok: boolean }> {
    const wc = this.guest;
    if (!wc) return { ok: false };
    if (action === "back" && wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack();
    } else if (action === "forward" && wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward();
    } else if (action === "reload") {
      wc.reload();
    } else if (action === "stop") {
      wc.stop();
    }
    this.syncNavigationFlags();
    return { ok: true };
  }

  async clearData(): Promise<{ ok: boolean }> {
    if (!this.partition) return { ok: false };
    await session.fromPartition(this.partition).clearStorageData();
    this.guest?.reload();
    return { ok: true };
  }

  /**
   * Real DevTools and a CDP attachment cannot coexist on one WebContents, so
   * opening DevTools disarms the element picker and detaches the debugger.
   */
  toggleDevTools(): { ok: boolean; open: boolean } {
    const wc = this.guest;
    if (!wc) return { ok: false, open: false };
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools();
      this.update({ devtoolsOpen: false });
      return { ok: true, open: false };
    }
    this.cancelPick();
    this.detachDebugger();
    wc.openDevTools({ mode: "detach" });
    this.update({ devtoolsOpen: true });
    return { ok: true, open: true };
  }

  /**
   * Arm Chromium's own inspect mode: the next click in the page selects a node
   * instead of reaching the app. Using the browser's picker rather than an
   * injected script means nothing is added to the project's page.
   */
  async pickElement(): Promise<{ ok: boolean; error?: string }> {
    const wc = this.guest;
    if (!wc || this.status.phase !== "ready") {
      const error = "The preview has no page loaded yet.";
      return { ok: false, error };
    }
    if (wc.isDevToolsOpened()) {
      const error = "Close DevTools first — the picker needs the debugger.";
      this.update({ error });
      return { ok: false, error };
    }
    try {
      this.attachDebugger(wc);
      await wc.debugger.sendCommand("DOM.enable");
      await wc.debugger.sendCommand("Overlay.enable");
      await wc.debugger.sendCommand("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: {
          showInfo: true,
          contentColor: { r: 111, g: 168, b: 220, a: 0.35 },
          paddingColor: { r: 147, g: 196, b: 125, a: 0.3 },
          borderColor: { r: 255, g: 229, b: 153, a: 0.5 },
          marginColor: { r: 246, g: 178, b: 107, a: 0.35 },
        },
      });
      this.update({ picking: true, error: null });
      return { ok: true };
    } catch (error) {
      this.detachDebugger();
      const message = `Could not start the element picker: ${describeError(error)}`;
      this.update({ picking: false, error: message });
      return { ok: false, error: message };
    }
  }

  cancelPick(): void {
    if (!this.status.picking) return;
    this.update({ picking: false });
    const wc = this.guest;
    if (!wc || !this.debuggerAttached) return;
    void wc.debugger
      .sendCommand("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      })
      .catch(() => undefined);
  }

  /**
   * Freeze frame for the crop overlay. The renderer draws this bitmap over the
   * hole and crops from it, which is the only way to paint a selection
   * rectangle above a native view.
   */
  async capture(): Promise<PreviewCapture | null> {
    const wc = this.guest;
    if (!wc) return null;
    const image = await wc.capturePage();
    if (image.isEmpty()) return null;
    const size = image.getSize();
    return {
      dataBase64: image.toPNG().toString("base64"),
      mime: "image/png",
      width: size.width,
      height: size.height,
      url: this.status.url,
      viewRect: this.status.viewRect,
    };
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.listeners.clear();
    this.elementListeners.clear();
    this.win = null;
  }

  private attachDebugger(wc: WebContents): void {
    if (this.debuggerAttached) return;
    wc.debugger.attach("1.3");
    this.debuggerAttached = true;
  }

  private detachDebugger(): void {
    if (!this.debuggerAttached) return;
    this.debuggerAttached = false;
    try {
      this.guest?.debugger.detach();
    } catch {
      /* already gone with the view */
    }
  }

  /**
   * A node was picked. Inspect mode goes off first so the CDP highlight is not
   * baked into the crop, then the page tells us how to find the element again
   * and the view gives us a tight shot of it.
   */
  private async collectElement(backendNodeId: number): Promise<void> {
    const wc = this.guest;
    if (!wc || !this.debuggerAttached) return;
    this.update({ picking: false });
    let objectId: string | undefined;
    try {
      await wc.debugger.sendCommand("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: {},
      });
      await wc.debugger.sendCommand("Overlay.hideHighlight");

      const resolved = (await wc.debugger.sendCommand("DOM.resolveNode", {
        backendNodeId,
      })) as { object?: { objectId?: string } };
      objectId = resolved.object?.objectId;
      if (!objectId) return;

      const evaluated = (await wc.debugger.sendCommand(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: ELEMENT_COLLECTOR,
          returnByValue: true,
        },
      )) as { result?: { value?: CollectedElement } };
      const collected = evaluated.result?.value;
      if (!collected) return;

      const bounds = this.status.viewRect ?? this.paneRect;
      const rect = padAndClampRect(
        collected.rect,
        bounds?.width ?? 0,
        bounds?.height ?? 0,
      );
      let image: PreviewElementSelection["image"];
      if (rect.width >= 2 && rect.height >= 2) {
        const shot = await wc.capturePage(rect);
        if (!shot.isEmpty()) {
          image = {
            dataBase64: shot.toPNG().toString("base64"),
            mime: "image/png",
          };
        }
      }

      const selection: PreviewElementSelection = {
        at: new Date().toISOString(),
        url: this.status.url,
        tagName: collected.tagName,
        selectors: collected.selectors.slice(0, 8),
        testId: collected.testId,
        role: collected.role,
        accessibleName: collected.accessibleName,
        text: collected.text,
        classNames: collected.classNames.slice(0, 12),
        componentChain: collected.componentChain.slice(0, 8),
        rect,
        ...(image ? { image } : {}),
      };
      for (const listener of this.elementListeners) listener(selection);
    } catch (error) {
      this.update({
        error: `Could not read the selected element: ${describeError(error)}`,
      });
    } finally {
      if (objectId) {
        try {
          await wc.debugger.sendCommand("Runtime.releaseObject", { objectId });
        } catch {
          /* context already gone */
        }
      }
      this.detachDebugger();
    }
  }

  private ensurePartition(): void {
    if (this.partition) {
      if (!this.status.partition) this.update({ partition: this.partition });
      return;
    }
    const projectId = this.host.projectId() ?? "default";
    this.partition = `${PARTITION_PREFIX}${projectId}`;
    // Touch the session so the renderer webview can join the same partition.
    session.fromPartition(this.partition, { cache: true });
    this.update({ partition: this.partition });
    this.applyBounds();
    this.applyVisibility();
  }

  private wireGuest(wc: WebContents): void {
    wc.on("will-navigate", (event, url) => {
      if (url === "about:blank" || isAllowedPreviewUrl(url)) return;
      event.preventDefault();
      this.update({ error: describePreviewUrlRejection(url) });
    });

    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedPreviewUrl(url)) {
        void this.loadTarget(url);
      } else {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    wc.on("did-start-loading", () => this.update({ loading: true }));

    wc.on("did-stop-loading", () => {
      this.update({ loading: false });
      this.syncNavigationFlags();
    });

    wc.on("did-navigate", (_event, url) => {
      if (url === "about:blank") {
        this.syncNavigationFlags();
        return;
      }
      this.update({ url, phase: "ready", error: null });
      this.syncNavigationFlags();
    });

    wc.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) this.update({ url });
      this.syncNavigationFlags();
    });

    wc.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 is ABORTED: a navigation the app itself replaced.
      if (!isMainFrame || code === -3 || url === "about:blank") return;
      // wait-on should have blocked this; if a race still hits a closed
      // port, stay on "waiting" instead of flashing the red error.
      if (code === ERR_CONNECTION_REFUSED && this.status.phase === "waiting") {
        return;
      }
      this.update({
        phase: "error",
        error: `Could not load ${url} (${description}).`,
      });
    });

    wc.on("render-process-gone", () => {
      this.update({ phase: "error", error: "The preview page crashed." });
    });

    wc.on("console-message", (details) => {
      if (details.level !== "error" && details.level !== "warning") return;
      const entry = {
        level: details.level,
        message: details.message.slice(0, 4_000),
        at: new Date().toISOString(),
      };
      const recentConsole = [...this.status.recentConsole, entry].slice(
        -PREVIEW_CONSOLE_BUFFER_MAX,
      );
      this.update({
        recentConsole,
        consoleErrorCount:
          this.status.consoleErrorCount + (details.level === "error" ? 1 : 0),
      });
    });

    wc.on("devtools-closed", () => this.update({ devtoolsOpen: false }));

    // Registered once per view: the debugger object outlives attach/detach, so
    // wiring this on every attach would fire the handler twice.
    wc.debugger.on("detach", () => {
      this.debuggerAttached = false;
      if (this.status.picking) this.update({ picking: false });
    });

    wc.debugger.on("message", (_event, method, params) => {
      if (method !== "Overlay.inspectNodeRequested") return;
      const backendNodeId = (params as { backendNodeId?: number })
        .backendNodeId;
      if (typeof backendNodeId !== "number") return;
      void this.collectElement(backendNodeId);
    });

    // A reload while armed leaves inspect mode behind in the old document.
    wc.on("did-start-navigation", () => this.cancelPick());
  }

  private releaseGuest(): void {
    this.detachDebugger();
    const guest = this.guest;
    this.guest = null;
    if (!guest || guest.isDestroyed()) return;
    try {
      if (guest.isDevToolsOpened()) guest.closeDevTools();
    } catch {
      /* already gone */
    }
  }

  private applyVisibility(): void {
    // The renderer hides the <webview> while a dialog is up.
  }

  private applyBounds(): void {
    if (!this.paneRect || this.paneRect.width < 8 || this.paneRect.height < 8) {
      this.update({ viewRect: null });
      return;
    }
    const rect = fitPreviewViewport(this.paneRect, this.status.viewport);
    this.update({ viewRect: rect });
  }

  private syncNavigationFlags(): void {
    const wc = this.guest;
    if (!wc) return;
    this.update({
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
  }

  private async loadTarget(url: string): Promise<void> {
    this.pendingUrl = url;
    this.loadToken += 1;
    const token = this.loadToken;
    this.waitAbort?.abort();
    const abort = new AbortController();
    this.waitAbort = abort;
    this.update({ phase: "waiting", error: null, url });

    const ready = await waitForPreviewUrl(url, {
      timeoutMs: PREVIEW_URL_WAIT_MS,
      signal: abort.signal,
    });
    if (token !== this.loadToken) return;
    if (!ready) {
      if (abort.signal.aborted) return;
      this.update({
        phase: "error",
        error: `Timed out waiting for ${url}. Is the dev server running?`,
      });
      return;
    }

    const wc = this.guest;
    if (!wc) return;
    try {
      await wc.loadURL(url);
    } catch (error) {
      if (token !== this.loadToken || !this.guest) return;
      this.update({
        phase: "error",
        error: `Could not reach ${url}: ${describeError(error)}`,
      });
    }
  }

  private onTerminalData(event: { terminalId: string; data: string }): void {
    const serviceId = [...this.serviceTerminals.entries()].find(
      ([, terminalId]) => terminalId === event.terminalId,
    )?.[0];
    if (!serviceId) return;
    const service = this.status.services.find((s) => s.id === serviceId);
    if (!service || service.url) return;

    const buffer = (
      (this.sniffBuffers.get(event.terminalId) ?? "") + event.data
    ).slice(-SNIFF_BUFFER_MAX);
    this.sniffBuffers.set(event.terminalId, buffer);

    const url = parseDevServerUrl(buffer);
    if (!url) return;
    this.sniffBuffers.delete(event.terminalId);
    this.patchService(serviceId, { url, status: "ready" });
    if (service.role === "web" && !this.status.url) {
      void this.loadTarget(url);
    }
  }

  private patchService(id: string, patch: Partial<PreviewService>): void {
    this.update({
      services: this.status.services.map((service) =>
        service.id === id ? { ...service, ...patch } : service,
      ),
    });
  }

  private update(patch: Partial<PreviewStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shape the in-page collector returns; validated only by its own caps. */
type CollectedElement = {
  tagName: string;
  selectors: string[];
  testId: string | null;
  role: string | null;
  accessibleName: string | null;
  text: string | null;
  classNames: string[];
  componentChain: string[];
  rect: { x: number; y: number; width: number; height: number };
};

const ELEMENT_CROP_PADDING = 6;

/** A tight crop cuts the border off; a crop outside the view fails to capture. */
function padAndClampRect(
  rect: { x: number; y: number; width: number; height: number },
  viewWidth: number,
  viewHeight: number,
): PreviewRect {
  const left = Math.max(0, Math.floor(rect.x) - ELEMENT_CROP_PADDING);
  const top = Math.max(0, Math.floor(rect.y) - ELEMENT_CROP_PADDING);
  const right = Math.min(
    viewWidth,
    Math.ceil(rect.x + rect.width) + ELEMENT_CROP_PADDING,
  );
  const bottom = Math.min(
    viewHeight,
    Math.ceil(rect.y + rect.height) + ELEMENT_CROP_PADDING,
  );
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}
