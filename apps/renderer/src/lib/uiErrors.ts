export type UiErrorReport = {
  id: string;
  title: string;
  message: string;
  detail?: string;
  source?: string;
  createdAt: number;
};

type Listener = (error: UiErrorReport | null) => void;

const listeners = new Set<Listener>();
let current: UiErrorReport | null = null;
const recentKeys = new Map<string, number>();
const DEDUPE_MS = 4000;

function notify(): void {
  for (const listener of listeners) listener(current);
}

function makeId(): string {
  return `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function dedupeKey(title: string, message: string): string {
  return `${title}::${message}`.slice(0, 280);
}

/** Show a front-of-screen error dialog (deduped). */
export function reportUiError(input: {
  title: string;
  message: string;
  detail?: string;
  source?: string;
}): void {
  const key = dedupeKey(input.title, input.message);
  const now = Date.now();
  const last = recentKeys.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return;
  recentKeys.set(key, now);

  current = {
    id: makeId(),
    title: input.title,
    message: input.message,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.source ? { source: input.source } : {}),
    createdAt: now,
  };
  notify();
}

export function dismissUiError(): void {
  current = null;
  notify();
}

export function getUiError(): UiErrorReport | null {
  return current;
}

export function subscribeUiError(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

function formatUnknown(err: unknown): { message: string; detail?: string } {
  if (err instanceof Error) {
    return {
      message: err.message || err.name,
      ...(err.stack ? { detail: err.stack } : {}),
    };
  }
  if (typeof err === "string") return { message: err };
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}

/** Ignore noisy Monaco/vite worker noise after environment is fixed, still surface real breaks. */
function shouldIgnore(message: string, source?: string): boolean {
  const m = message.toLowerCase();
  if (m.includes("resizeobserver loop")) return true;
  if (m.includes("monacoenvironment.getworkerurl") && source?.includes("monaco")) {
    // Still report once via dedicated path; skip raw flood.
    return false;
  }
  return false;
}

/**
 * Errors that leave React unable to render again: an exhausted heap, or one of
 * the scheduler invariants it throws asynchronously from a task no error
 * boundary sits under. The tree stops updating and the window is simply dark
 * from then on.
 */
const FATAL_PATTERNS = [
  "out of memory",
  "should not already be working",
  "maximum call stack size exceeded",
];

function isFatalRendererError(message: string): boolean {
  const m = message.toLowerCase();
  return FATAL_PATTERNS.some((pattern) => m.includes(pattern));
}

/**
 * Deliberately plain DOM: the whole point is that React is no longer running, so
 * the escape hatch cannot be a component. Says what happened, that nothing was
 * lost, and offers the one action that helps.
 */
function showFatalOverlay(message: string): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("fatal-overlay")) return;

  const reload = () => window.location.reload();

  const overlay = document.createElement("div");
  overlay.id = "fatal-overlay";
  overlay.className = "fatal-overlay";
  overlay.setAttribute("role", "alert");

  const title = document.createElement("strong");
  title.textContent = "The interface stopped rendering";

  const detail = document.createElement("p");
  detail.className = "fatal-overlay-detail";
  detail.textContent = message;

  const hint = document.createElement("p");
  hint.textContent =
    "This chat is saved on disk. Reload the window to pick it up where it stopped.";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-primary";
  button.textContent = "Reload · Enter";
  button.addEventListener("click", reload);

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    reload();
  };
  window.addEventListener("keydown", onKey, true);

  overlay.append(title, detail, hint, button);
  document.body.appendChild(overlay);
  button.focus();
}

let installed = false;

/** Install window-level handlers once (renderer). */
export function installUiErrorHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    const message = event.message || event.error?.message || "Unknown error";
    if (shouldIgnore(message, event.filename)) return;
    const formatted = formatUnknown(event.error ?? message);
    if (isFatalRendererError(formatted.message)) {
      showFatalOverlay(formatted.message);
    }
    reportUiError({
      title: "Renderer error",
      message: formatted.message,
      ...(formatted.detail ? { detail: formatted.detail } : {}),
      source: event.filename
        ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
        : "window.error",
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const formatted = formatUnknown(event.reason);
    if (shouldIgnore(formatted.message)) return;
    reportUiError({
      title: "Unhandled promise rejection",
      message: formatted.message,
      ...(formatted.detail ? { detail: formatted.detail } : {}),
      source: "unhandledrejection",
    });
  });
}
