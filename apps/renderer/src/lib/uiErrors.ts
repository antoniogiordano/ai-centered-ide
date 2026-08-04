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

let installed = false;

/** Install window-level handlers once (renderer). */
export function installUiErrorHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    const message = event.message || event.error?.message || "Unknown error";
    if (shouldIgnore(message, event.filename)) return;
    const formatted = formatUnknown(event.error ?? message);
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
