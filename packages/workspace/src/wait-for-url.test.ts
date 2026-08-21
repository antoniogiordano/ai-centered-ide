import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  toWaitOnHttpGetResource,
  waitForPreviewUrl,
} from "./wait-for-url.js";

function listen(
  port = 0,
  handler: (res: import("node:http").ServerResponse) => void = (res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  },
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((_req, res) => {
      handler(res);
    });
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("server has no port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        port: addr.port,
        close: () =>
          new Promise((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
    server.on("error", reject);
  });
}

function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("server has no port"));
        return;
      }
      const port = addr.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

describe("toWaitOnHttpGetResource", () => {
  it("rewrites http(s) to the GET probe Cypress uses", () => {
    expect(toWaitOnHttpGetResource("http://localhost:3012/")).toBe(
      "http-get://localhost:3012/",
    );
    expect(toWaitOnHttpGetResource("https://127.0.0.1:4443/app")).toBe(
      "https-get://127.0.0.1:4443/app",
    );
  });
});

describe("waitForPreviewUrl", () => {
  it("resolves once the URL answers", async () => {
    const server = await listen();
    try {
      await expect(
        waitForPreviewUrl(server.url, { timeoutMs: 3_000, intervalMs: 50 }),
      ).resolves.toBe(true);
    } finally {
      await server.close();
    }
  });

  it("waits for a server that is not listening yet", async () => {
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}/`;
    const pending = waitForPreviewUrl(url, { timeoutMs: 3_000, intervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const server = await listen(port);
    try {
      await expect(pending).resolves.toBe(true);
    } finally {
      await server.close();
    }
  });

  it("returns false when the port never opens", async () => {
    const port = await unusedPort();
    await expect(
      waitForPreviewUrl(`http://127.0.0.1:${port}/`, {
        timeoutMs: 400,
        intervalMs: 50,
      }),
    ).resolves.toBe(false);
  });

  it("treats a 307 auth-wall as ready and does not follow the loop", async () => {
    const server = await listen(0, (res) => {
      res.writeHead(307, { location: "/api/auth/test-login?redirect=%2F" });
      res.end();
    });
    try {
      await expect(
        waitForPreviewUrl(server.url, { timeoutMs: 2_000, intervalMs: 50 }),
      ).resolves.toBe(true);
    } finally {
      await server.close();
    }
  });

  it("returns false when aborted", async () => {
    const port = await unusedPort();
    const controller = new AbortController();
    const pending = waitForPreviewUrl(`http://127.0.0.1:${port}/`, {
      timeoutMs: 5_000,
      intervalMs: 50,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toBe(false);
  });
});
