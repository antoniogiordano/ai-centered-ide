import { createRequire } from "node:module";

/**
 * Wait until a local URL answers HTTP, the same way Cypress does via
 * start-server-and-test → wait-on.
 *
 * The preview must not call loadURL until this returns true: a closed port
 * becomes ERR_CONNECTION_REFUSED and the pane paints that as a red error
 * even though the server is still compiling. This file only waits; it does
 * not start processes or decide which URL to use.
 */

const require = createRequire(import.meta.url);
const waitOn = require("wait-on") as (opts: {
  resources: string[];
  timeout?: number;
  interval?: number;
  window?: number;
  httpTimeout?: number;
  followRedirect?: boolean;
  validateStatus?: (status: number) => boolean;
}) => Promise<void>;

/** Cold Next/Vite can sit on the port for a minute before the first 2xx. */
export const PREVIEW_URL_WAIT_MS = 90_000;

export type WaitForPreviewUrlOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
};

/**
 * wait-on HEAD-probes `http://…`. Some frameworks ignore HEAD, so Cypress
 * setups use the `http-get:` prefix. Same rewrite here.
 */
export function toWaitOnHttpGetResource(url: string): string {
  if (url.startsWith("https://")) return `https-get:${url.slice("https:".length)}`;
  if (url.startsWith("http://")) return `http-get:${url.slice("http:".length)}`;
  return url;
}

export async function waitForPreviewUrl(
  url: string,
  options: WaitForPreviewUrlOptions = {},
): Promise<boolean> {
  if (options.signal?.aborted) return false;
  const timeoutMs = options.timeoutMs ?? PREVIEW_URL_WAIT_MS;
  const intervalMs = options.intervalMs ?? 250;

  const ready = waitOn({
    resources: [toWaitOnHttpGetResource(url)],
    timeout: timeoutMs,
    interval: intervalMs,
    window: 0,
    httpTimeout: 1_000,
    // Auth walls 307 to a login that then 307s back. Following that without
    // a cookie jar never finishes; a status from the first hop is enough.
    followRedirect: false,
    validateStatus: (status) => status >= 100 && status < 500,
  })
    .then(() => true)
    .catch(() => false);

  const signal = options.signal;
  if (!signal) return ready;

  return new Promise((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    void ready.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    });
  });
}
