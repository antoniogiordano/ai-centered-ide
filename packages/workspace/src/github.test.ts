import { describe, expect, it, vi } from "vitest";
import { AppError } from "@ai-ide/shared";
import { GithubClient } from "./github.js";

describe("GithubClient", () => {
  it("starts device flow", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        device_code: "dc",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    );
    const client = new GithubClient(fetchImpl as unknown as typeof fetch);
    const start = await client.startDeviceFlow("client");
    expect(start.userCode).toBe("ABCD-1234");
    expect(start.deviceCode).toBe("dc");
    expect(start.verificationUriComplete).toBeNull();
  });

  it("prefers verification_uri_complete when present", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        device_code: "dc",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        verification_uri_complete:
          "https://github.com/login/device?user_code=ABCD-1234",
        expires_in: 900,
        interval: 5,
      }),
    );
    const client = new GithubClient(fetchImpl as unknown as typeof fetch);
    const start = await client.startDeviceFlow("client");
    expect(start.verificationUriComplete).toContain("user_code=");
  });

  it("polls until access token", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("access_token")) {
        n += 1;
        if (n === 1) {
          return Response.json({ error: "authorization_pending" });
        }
        return Response.json({ access_token: "gho_test" });
      }
      return Response.json({});
    });
    const client = new GithubClient(fetchImpl as unknown as typeof fetch);
    const token = await client.pollAccessToken("client", "dc", 0);
    expect(token).toBe("gho_test");
  });

  it("creates a repository", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        name: "demo",
        html_url: "https://github.com/u/demo",
        clone_url: "https://github.com/u/demo.git",
        private: true,
      }),
    );
    const client = new GithubClient(fetchImpl as unknown as typeof fetch);
    const repo = await client.createRepo("tok", { name: "demo", private: true });
    expect(repo.cloneUrl).toContain("demo.git");
  });

  it("maps create failure", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ message: "name already exists on this account" }, { status: 422 }),
    );
    const client = new GithubClient(fetchImpl as unknown as typeof fetch);
    await expect(client.createRepo("tok", { name: "demo" })).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
