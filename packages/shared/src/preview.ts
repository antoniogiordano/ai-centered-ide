import { z } from "zod";

/**
 * Live preview surface: the running web app embedded in the IDE.
 *
 * The page is untrusted content, so everything the renderer is allowed to ask
 * for lives here as a validated contract and the loopback-only URL policy is a
 * pure function the main process applies before every navigation.
 */

export const PreviewViewportIdSchema = z.enum(["desktop", "tablet", "mobile"]);
export type PreviewViewportId = z.infer<typeof PreviewViewportIdSchema>;

/** `null` size means "fill the pane" (desktop). */
export const PREVIEW_VIEWPORTS: ReadonlyArray<{
  id: PreviewViewportId;
  label: string;
  shortcut: string;
  width: number | null;
  height: number | null;
}> = [
  { id: "desktop", label: "Desktop", shortcut: "1", width: null, height: null },
  { id: "tablet", label: "Tablet", shortcut: "2", width: 834, height: 1112 },
  { id: "mobile", label: "Mobile", shortcut: "3", width: 390, height: 844 },
];

export const PreviewServiceRoleSchema = z.enum(["web", "support"]);
export type PreviewServiceRole = z.infer<typeof PreviewServiceRoleSchema>;

export const PreviewServiceStatusSchema = z.enum([
  "pending",
  "starting",
  "ready",
  "exited",
]);
export type PreviewServiceStatus = z.infer<typeof PreviewServiceStatusSchema>;

export const PreviewServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  role: PreviewServiceRoleSchema,
  /** PTY that runs it, so the user sees the same output as any other terminal. */
  terminalId: z.string().nullable(),
  status: PreviewServiceStatusSchema,
  /** Discovered from the process output, never guessed. */
  url: z.string().nullable(),
});
export type PreviewService = z.infer<typeof PreviewServiceSchema>;

export const PreviewRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type PreviewRect = z.infer<typeof PreviewRectSchema>;

export const PreviewPhaseSchema = z.enum([
  "off",
  /** No dev command in .aici/ARCHITECTURE.md yet: the agent has to work it out. */
  "needs_command",
  /** The agent proposed one; a human still has to sign off before it runs. */
  "needs_confirm",
  "starting",
  "waiting",
  "ready",
  "error",
]);
export type PreviewPhase = z.infer<typeof PreviewPhaseSchema>;

export const PreviewSetupSchema = z.object({
  /** Confirmed or proposed command; null when nobody has answered yet. */
  command: z.string().nullable(),
  /** False while the value is only `agent_proposed`. */
  confirmed: z.boolean(),
  supportCount: z.number().int().nonnegative(),
  /** Dev scripts found in the repo, as context for the human and the agent. */
  candidates: z
    .array(
      z.object({
        name: z.string(),
        command: z.string(),
        testVariant: z.boolean(),
      }),
    )
    .max(20),
});
export type PreviewSetup = z.infer<typeof PreviewSetupSchema>;

export function createEmptyPreviewSetup(): PreviewSetup {
  return {
    command: null,
    confirmed: false,
    supportCount: 0,
    candidates: [],
  };
}

/**
 * The message the human sends to hand the question to the agent. Written here
 * rather than in the button so the wording, the tool name and the warning about
 * test variants stay in one place.
 */
export function buildPreviewSetupRequest(setup: PreviewSetup): string {
  const lines = [
    "Set up the live preview for this project.",
    "",
    "Work out the single command that runs the app locally, plus any process it needs alongside (API, worker, database container). Read package.json, the README and any compose file instead of assuming a convention. Avoid variants meant for automated tests: they run on another port against seeded data.",
    "",
    "Then call upsert_architecture with a `dev` section: { command, support?: [{ name, command }], url? }. Set `url` only if the server does not print its address on startup. I confirm it in the preview before anything runs.",
  ];
  if (setup.candidates.length) {
    lines.push("", "Dev scripts in package.json:");
    for (const candidate of setup.candidates) {
      lines.push(
        `- ${candidate.name}: ${candidate.command}${
          candidate.testVariant ? " (looks like a test variant)" : ""
        }`,
      );
    }
  }
  return lines.join("\n");
}

export const PreviewConsoleEntrySchema = z.object({
  level: z.enum(["warning", "error"]),
  message: z.string().max(4_000),
  at: z.string(),
});
export type PreviewConsoleEntry = z.infer<typeof PreviewConsoleEntrySchema>;

export const PREVIEW_CONSOLE_BUFFER_MAX = 50;

/**
 * What a picked DOM element tells the agent. Deliberately only selectors,
 * text and the React component chain: enough to grep the source, with no
 * build-time instrumentation of the project (see docs/notes for the rejected
 * source-mapping options).
 */
export const PreviewElementSelectionSchema = z.object({
  at: z.string(),
  url: z.string().nullable(),
  tagName: z.string(),
  /** Ranked, most stable first. */
  selectors: z.array(z.string()).max(8),
  testId: z.string().nullable(),
  role: z.string().nullable(),
  accessibleName: z.string().nullable(),
  text: z.string().nullable(),
  classNames: z.array(z.string()).max(12),
  /** Nearest React component first; empty when the page is not React. */
  componentChain: z.array(z.string()).max(8),
  /** Viewport-relative CSS pixels, the frame of the cropped shot. */
  rect: PreviewRectSchema,
  image: z
    .object({
      dataBase64: z.string().min(1),
      mime: z.literal("image/png"),
    })
    .optional(),
});
export type PreviewElementSelection = z.infer<
  typeof PreviewElementSelectionSchema
>;

/**
 * One-line handle the human drops in the composer. The agent gets a target it
 * can search for; the attached crop says what it looks like.
 */
export function formatElementReference(
  selection: PreviewElementSelection,
): string {
  const parts: string[] = [`<${selection.tagName}>`];
  if (selection.accessibleName) parts.push(`“${selection.accessibleName}”`);
  else if (selection.text) parts.push(`“${selection.text}”`);
  const head = parts.join(" ");
  const lines = [`Element: ${head}`];
  if (selection.selectors.length) {
    lines.push(`Selectors: ${selection.selectors.join(" | ")}`);
  }
  if (selection.componentChain.length) {
    lines.push(`Components: ${selection.componentChain.join(" ‹ ")}`);
  }
  if (selection.url) lines.push(`Page: ${selection.url}`);
  return lines.join("\n");
}

export const PreviewStatusSchema = z.object({
  enabled: z.boolean(),
  phase: PreviewPhaseSchema,
  /** The repo has at least one dev script, so a preview is conceivable. */
  supported: z.boolean(),
  /** Where the "how do I run this?" answer stands. */
  setup: PreviewSetupSchema,
  url: z.string().nullable(),
  services: z.array(PreviewServiceSchema),
  viewport: PreviewViewportIdSchema,
  /** Window-relative rect actually occupied by the guest page. */
  viewRect: PreviewRectSchema.nullable(),
  /**
   * Session partition the renderer webview must use. The guest is a DOM
   * `<webview>` (Electron 36 cannot keep a WebContentsView above the
   * renderer), but isolation still lives here: no preload, loopback-only.
   */
  partition: z.string().nullable(),
  visible: z.boolean(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  devtoolsOpen: z.boolean(),
  /** Element picker armed: the next click in the page selects instead of acting. */
  picking: z.boolean(),
  consoleErrorCount: z.number().int().nonnegative(),
  recentConsole: z.array(PreviewConsoleEntrySchema),
  error: z.string().nullable(),
});
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

export function createEmptyPreviewStatus(): PreviewStatus {
  return {
    enabled: false,
    phase: "off",
    supported: false,
    setup: createEmptyPreviewSetup(),
    url: null,
    services: [],
    viewport: "desktop",
    viewRect: null,
    partition: null,
    visible: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    devtoolsOpen: false,
    picking: false,
    consoleErrorCount: 0,
    recentConsole: [],
    error: null,
  };
}

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // Vite/Next dev certs and mDNS aliases: `myapp.localhost`.
  return host.endsWith(".localhost");
}

/**
 * Target policy for the preview surface. Loopback is always allowed because
 * that is where the dev server lives; anything else must be explicitly
 * allowlisted by the human. Non-http schemes never load — `javascript:` and
 * `file:` inside the preview would be a way out of the sandbox.
 */
export function isAllowedPreviewUrl(
  raw: string,
  options?: { allowedOrigins?: readonly string[] },
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (isLoopbackHost(parsed.hostname)) return true;
  const allowed = options?.allowedOrigins ?? [];
  return allowed.some((origin) => {
    try {
      return new URL(origin).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}

/** Same rules as the address bar, plus a friendlier reason for the UI. */
export function describePreviewUrlRejection(raw: string): string {
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    return "Enter a full URL, for example http://localhost:3000";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Only http and https can load in the preview (got ${parsed.protocol}).`;
  }
  return `${parsed.host} is outside the preview allowlist — only your local dev servers load here.`;
}

/** Dev servers colour their output; the escape codes glue onto the URL. */
const ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`,
  "g",
);

function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE, "");
}

const URL_IN_OUTPUT = /https?:\/\/[^\s"'<>()[\]]+/gi;
const PORT_IN_OUTPUT =
  /(?:port|listening on|running at)[^\d\n]{0,12}(\d{2,5})/gi;

/**
 * Read the dev server URL out of process output instead of guessing a port.
 * Vite, Next and CRA all print a `Local:` line; plain Node servers usually
 * print a port. A `Local:` hit wins, then the last loopback URL seen (dev
 * servers reprint on restart), then a bare port.
 */
export function parseDevServerUrl(output: string): string | null {
  const text = stripAnsi(output);

  let localLineHit: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!/local:/i.test(line)) continue;
    const hit = (line.match(URL_IN_OUTPUT) ?? [])
      .map(normalizeCandidate)
      .find(isLoopbackUrl);
    if (hit) localLineHit = hit;
  }
  if (localLineHit) return localLineHit;

  const urls = (text.match(URL_IN_OUTPUT) ?? [])
    .map(normalizeCandidate)
    .filter(isLoopbackUrl);
  if (urls.length) return urls[urls.length - 1]!;

  let portHit: string | null = null;
  for (const match of text.matchAll(PORT_IN_OUTPUT)) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port >= 80 && port <= 65_535) {
      portHit = `http://localhost:${port}/`;
    }
  }
  return portHit;
}

function normalizeCandidate(raw: string): string {
  // Terminal output often glues punctuation to the URL: `http://localhost:3000/.`
  const trimmed = raw.replace(/[.,;:!?)\]]+$/, "");
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

function isLoopbackUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Rect of the native view inside the pane the renderer reserved for it.
 * A fixed viewport preset is centred and letterboxed, and never grows past the
 * pane, so the crop overlay can align with the pixels the user actually sees.
 */
export function fitPreviewViewport(
  pane: PreviewRect,
  viewport: PreviewViewportId,
): PreviewRect {
  const preset = PREVIEW_VIEWPORTS.find((v) => v.id === viewport);
  const paneWidth = Math.max(0, Math.round(pane.width));
  const paneHeight = Math.max(0, Math.round(pane.height));
  if (!preset?.width || !preset.height) {
    return {
      x: Math.round(pane.x),
      y: Math.round(pane.y),
      width: paneWidth,
      height: paneHeight,
    };
  }
  const width = Math.min(preset.width, paneWidth);
  const height = Math.min(preset.height, paneHeight);
  return {
    x: Math.round(pane.x + (paneWidth - width) / 2),
    y: Math.round(pane.y + (paneHeight - height) / 2),
    width,
    height,
  };
}

/**
 * Drag rectangle (CSS pixels over the frozen capture) mapped onto the captured
 * bitmap. The capture can be at a different scale than the on-screen view on a
 * HiDPI display, hence the explicit ratio instead of assuming 1:1.
 */
export function cropRectToImagePixels(input: {
  start: { x: number; y: number };
  end: { x: number; y: number };
  displayedWidth: number;
  displayedHeight: number;
  imageWidth: number;
  imageHeight: number;
}): { x: number; y: number; width: number; height: number } | null {
  const {
    start,
    end,
    displayedWidth,
    displayedHeight,
    imageWidth,
    imageHeight,
  } = input;
  if (displayedWidth <= 0 || displayedHeight <= 0) return null;
  const scaleX = imageWidth / displayedWidth;
  const scaleY = imageHeight / displayedHeight;
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);

  const x = Math.round(Math.max(0, left) * scaleX);
  const y = Math.round(Math.max(0, top) * scaleY);
  const width = Math.round(Math.min(right, displayedWidth) * scaleX) - x;
  const height = Math.round(Math.min(bottom, displayedHeight) * scaleY) - y;
  // A click without a drag is not a crop.
  if (width < 2 || height < 2) return null;
  return {
    x,
    y,
    width: Math.min(width, imageWidth - x),
    height: Math.min(height, imageHeight - y),
  };
}
