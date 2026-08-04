import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AppError } from "@ai-ide/shared";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import {
  extractGhDeviceCode,
  extractGhLoginUrls,
  GhCli,
} from "./gh.js";

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

describe("extractGhLoginUrls / extractGhDeviceCode", () => {
  it("parses device URL and code from gh stderr", () => {
    const text = `
! One-time code (2A97-8A69) copied to clipboard
Open this URL to continue in your web browser: https://github.com/login/device
`;
    expect(extractGhLoginUrls(text)).toEqual([
      "https://github.com/login/device",
    ]);
    expect(extractGhDeviceCode(text)).toBe("2A97-8A69");
  });
});

function mockExecSequence(
  handlers: Array<(args: string[]) => { stdout: string } | Error>,
) {
  let i = 0;
  execFileMock.mockImplementation(
    (
      _bin: string,
      args: string[],
      optsOrCb:
        | object
        | ((
            err: Error | null,
            stdout: string,
            stderr: string,
          ) => void),
      maybeCb?: (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb!;
      const handler = handlers[i++] ?? (() => ({ stdout: "" }));
      const result = handler(args);
      if (result instanceof Error) {
        const err = result as Error & { stdout?: string; stderr?: string };
        if (err.stderr === undefined) err.stderr = err.message;
        if (err.stdout === undefined) err.stdout = "";
        cb(err, err.stdout, err.stderr);
        return;
      }
      cb(null, result.stdout, "");
    },
  );
}

describe("GhCli", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports missing binary", async () => {
    const cli = new GhCli(null);
    const status = await cli.status();
    expect(status.installed).toBe(false);
    expect(status.authenticated).toBe(false);
  });

  it("lists user and orgs when authenticated", async () => {
    mockExecSequence([
      () => ({ stdout: "" }),
      () => ({ stdout: "alice\n" }),
      () => ({ stdout: "acme\nwidgets\n" }),
    ]);
    const cli = new GhCli("/usr/bin/gh");
    const status = await cli.status();
    expect(status.authenticated).toBe(true);
    expect(status.login).toBe("alice");
    expect(status.owners).toEqual([
      { login: "alice", type: "user" },
      { login: "acme", type: "org" },
      { login: "widgets", type: "org" },
    ]);
  });

  it("createRepo runs gh repo create with owner", async () => {
    mockExecSequence([
      () => ({ stdout: "" }),
      () => ({ stdout: "alice\n" }),
      () => ({ stdout: "" }),
      () => ({ stdout: "" }),
      () => ({
        stdout: JSON.stringify({
          url: "https://github.com/alice/demo",
          sshUrl: "git@github.com:alice/demo.git",
          name: "demo",
        }),
      }),
    ]);
    const cli = new GhCli("/usr/bin/gh");
    const repo = await cli.createRepo({
      cwd: "/tmp/demo",
      name: "demo",
      owner: "alice",
      private: true,
    });
    expect(repo.htmlUrl).toContain("alice/demo");
    const createCall = execFileMock.mock.calls.find((c) =>
      (c[1] as string[]).includes("create"),
    );
    expect(createCall?.[1]).toEqual(
      expect.arrayContaining([
        "repo",
        "create",
        "alice/demo",
        "--private",
        "--source=.",
        "--remote=origin",
      ]),
    );
  });

  it("maps already-exists errors", async () => {
    mockExecSequence([
      () => ({ stdout: "" }),
      () => ({ stdout: "alice\n" }),
      () => ({ stdout: "" }),
      () => {
        const err = new Error("failed") as Error & { stderr: string };
        err.stderr = "GraphQL: Name already exists on this account";
        return err;
      },
    ]);
    const cli = new GhCli("/usr/bin/gh");
    await expect(
      cli.createRepo({
        cwd: "/tmp/demo",
        name: "demo",
        owner: "alice",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("logs out with hostname and user", async () => {
    mockExecSequence([() => ({ stdout: "" })]);
    const cli = new GhCli("/usr/bin/gh");
    await cli.logout("alice");
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      "auth",
      "logout",
      "--hostname",
      "github.com",
      "--user",
      "alice",
    ]);
  });
});
