import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { AppError } from "@ai-ide/shared";

const execFileAsync = promisify(execFile);

export type GhOwner = {
  login: string;
  type: "user" | "org";
};

export type GhStatus = {
  installed: boolean;
  authenticated: boolean;
  login: string | null;
  owners: GhOwner[];
  binary: string | null;
  detail: string | null;
};

export type GhCreatedRepo = {
  name: string;
  htmlUrl: string;
  cloneUrl: string;
  owner: string;
};

export type GhCliOptions = {
  binary?: string | null;
  /** Open device/login URLs (Electron: shell.openExternal). Required when stdout is not a TTY. */
  openUrl?: (url: string) => void | Promise<void>;
};

/** Extract GitHub login/device URLs from `gh auth login` output. */
export function extractGhLoginUrls(text: string): string[] {
  const matches = text.match(
    /https:\/\/github\.com\/login\/(?:device|oauth)[^\s)"]*/gi,
  );
  if (!matches) return [];
  return [...new Set(matches.map((u) => u.replace(/[.,;:]+$/, "")))];
}

/** Extract one-time device code from `gh auth login --web` output. */
export function extractGhDeviceCode(text: string): string | null {
  const m =
    text.match(/one-time code\s*\(([^)]+)\)/i) ??
    text.match(/one-time code:\s*([A-Z0-9-]+)/i);
  return m?.[1]?.trim() || null;
}

function resolveGhBinary(): string | null {
  const candidates = [
    process.env.GH_BINARY,
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
    "gh",
  ].filter((v): v is string => Boolean(v));
  for (const candidate of candidates) {
    if (candidate === "gh") return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function runGh(
  binary: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = (await execFileAsync(binary, args, {
      cwd: opts?.cwd,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env },
      encoding: "utf8",
    })) as unknown as
      | string
      | { stdout: string | Buffer; stderr: string | Buffer };

    // util.promisify(execFile) may resolve to a string (stdout) under mocks,
    // or { stdout, stderr } with Node's custom promisify.
    if (typeof result === "string") {
      return { stdout: result, stderr: "" };
    }
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number | string;
    };
    const detail = [err.stderr, err.stdout, err.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new AppError({
      code: "PROVIDER_ERROR",
      userMessage: summarizeGhError(detail),
      technicalDetail: detail.slice(0, 800) || `gh ${args.join(" ")} failed`,
    });
  }
}

function summarizeGhError(detail: string): string {
  const lower = detail.toLowerCase();
  if (lower.includes("not logged into") || lower.includes("to re-authenticate")) {
    return "GitHub CLI is not authenticated. Run: gh auth login";
  }
  if (lower.includes("HTTP 401") || lower.includes("bad credentials")) {
    return "GitHub CLI credentials expired. Run: gh auth login";
  }
  if (lower.includes("already exists")) {
    return "A repository with that name already exists on GitHub.";
  }
  if (lower.includes("gh: command not found") || lower.includes("enoent")) {
    return "GitHub CLI (gh) is not installed.";
  }
  const first = detail.split("\n").map((l) => l.trim()).find(Boolean);
  return first || "GitHub CLI command failed.";
}

export class GhCli {
  private readonly binaryOverride?: string | null;
  private readonly openUrl?: (url: string) => void | Promise<void>;

  constructor(binaryOrOptions?: string | null | GhCliOptions) {
    if (binaryOrOptions && typeof binaryOrOptions === "object") {
      if ("binary" in binaryOrOptions) {
        this.binaryOverride = binaryOrOptions.binary ?? null;
      }
      if (binaryOrOptions.openUrl) {
        this.openUrl = binaryOrOptions.openUrl;
      }
    } else if (binaryOrOptions !== undefined) {
      this.binaryOverride = binaryOrOptions;
    }
  }

  resolveBinary(): string | null {
    if (this.binaryOverride !== undefined) return this.binaryOverride;
    return resolveGhBinary();
  }

  async status(): Promise<GhStatus> {
    const binary = this.resolveBinary();
    if (!binary) {
      return {
        installed: false,
        authenticated: false,
        login: null,
        owners: [],
        binary: null,
        detail: "Install GitHub CLI from https://cli.github.com then run: gh auth login",
      };
    }

    try {
      await runGh(binary, ["auth", "status"]);
    } catch (error) {
      return {
        installed: true,
        authenticated: false,
        login: null,
        owners: [],
        binary,
        detail:
          error instanceof AppError
            ? error.userMessage
            : "Run: gh auth login",
      };
    }

    try {
      const { stdout } = await runGh(binary, [
        "api",
        "user",
        "--jq",
        ".login",
      ]);
      const login = stdout.trim();
      if (!login) {
        return {
          installed: true,
          authenticated: false,
          login: null,
          owners: [],
          binary,
          detail: "Could not read GitHub login. Run: gh auth login",
        };
      }

      const owners: GhOwner[] = [{ login, type: "user" }];
      try {
        const orgsOut = await runGh(binary, [
          "api",
          "user/orgs",
          "--jq",
          ".[].login",
        ]);
        for (const line of orgsOut.stdout.split("\n")) {
          const org = line.trim();
          if (org) owners.push({ login: org, type: "org" });
        }
      } catch {
        /* orgs optional */
      }

      return {
        installed: true,
        authenticated: true,
        login,
        owners,
        binary,
        detail: null,
      };
    } catch (error) {
      return {
        installed: true,
        authenticated: false,
        login: null,
        owners: [],
        binary,
        detail:
          error instanceof AppError
            ? error.userMessage
            : "Run: gh auth login",
      };
    }
  }

  /**
   * Log out of GitHub CLI for github.com (current user when known).
   * After this, the user runs `gh auth login` (or Refresh after logging in elsewhere).
   */
  async logout(user?: string | null): Promise<void> {
    const binary = this.resolveBinary();
    if (!binary) {
      throw new AppError({
        code: "NOT_FOUND",
        userMessage: "GitHub CLI (gh) is not installed.",
        technicalDetail: "gh binary missing",
      });
    }

    const args = ["auth", "logout", "--hostname", "github.com"];
    const login = user?.trim();
    if (login) {
      args.push("--user", login);
    }

    try {
      await runGh(binary, args);
    } catch (error) {
      // Older gh may not support --user; retry hostname-only.
      if (login) {
        try {
          await runGh(binary, ["auth", "logout", "--hostname", "github.com"]);
          return;
        } catch {
          /* fall through */
        }
      }
      throw error;
    }
  }

  /**
   * Browser-based login via GitHub CLI (`gh auth login --web`).
   * Without a TTY, `gh` prints the device URL and does not open a browser —
   * we parse that URL and call `openUrl` (e.g. Electron shell.openExternal).
   */
  async loginWeb(signal?: AbortSignal): Promise<GhStatus> {
    const binary = this.resolveBinary();
    if (!binary) {
      throw new AppError({
        code: "NOT_FOUND",
        userMessage: "GitHub CLI (gh) is not installed.",
        technicalDetail: "gh binary missing",
      });
    }

    let opened = false;
    let combined = "";
    const tryOpen = (chunk: string) => {
      if (opened || !this.openUrl) return;
      combined += chunk;
      const urls = extractGhLoginUrls(combined);
      if (!urls[0]) return;
      opened = true;
      void Promise.resolve(this.openUrl(urls[0])).catch(() => {
        /* user can still open the URL manually from clipboard/code */
      });
    };

    await runGhSpawn(
      binary,
      [
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
        "--web",
        "--clipboard",
      ],
      {
        timeoutMs: 10 * 60 * 1000,
        keepStdinOpen: true,
        onChunk: tryOpen,
        ...(signal ? { signal } : {}),
      },
    );
    return this.status();
  }

  /**
   * Login with a classic/fine-grained PAT via stdin (`gh auth login --with-token`).
   */
  async loginWithToken(token: string, signal?: AbortSignal): Promise<GhStatus> {
    const binary = this.resolveBinary();
    if (!binary) {
      throw new AppError({
        code: "NOT_FOUND",
        userMessage: "GitHub CLI (gh) is not installed.",
        technicalDetail: "gh binary missing",
      });
    }
    const trimmed = token.trim();
    if (!trimmed) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        userMessage: "Paste a GitHub personal access token.",
        technicalDetail: "empty token",
      });
    }

    await runGhSpawn(
      binary,
      ["auth", "login", "--hostname", "github.com", "--with-token"],
      {
        timeoutMs: 60_000,
        stdin: `${trimmed}\n`,
        ...(signal ? { signal } : {}),
      },
    );
    return this.status();
  }

  /**
   * Create an empty GitHub repo and set `origin` on the local git repo.
   * Does not push (no commits yet).
   */
  async createRepo(input: {
    cwd: string;
    name: string;
    owner: string;
    private?: boolean;
  }): Promise<GhCreatedRepo> {
    const binary = this.resolveBinary();
    if (!binary) {
      throw new AppError({
        code: "NOT_FOUND",
        userMessage: "GitHub CLI (gh) is not installed.",
        technicalDetail: "gh binary missing",
      });
    }

    const status = await this.status();
    if (!status.authenticated || !status.login) {
      throw new AppError({
        code: "PERMISSION_DENIED",
        userMessage: "GitHub CLI is not authenticated. Run: gh auth login",
        technicalDetail: status.detail ?? "unauthenticated",
      });
    }

    const owner = input.owner.trim() || status.login;
    if (!status.owners.some((o) => o.login === owner)) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        userMessage: `Owner "${owner}" is not available for this GitHub account.`,
        technicalDetail: status.owners.map((o) => o.login).join(","),
      });
    }

    const repoName = input.name.trim();
    const qualified = `${owner}/${repoName}`;
    const visibility = input.private === false ? "--public" : "--private";

    await runGh(
      binary,
      [
        "repo",
        "create",
        qualified,
        visibility,
        "--source=.",
        "--remote=origin",
      ],
      { cwd: input.cwd },
    );

    let htmlUrl = `https://github.com/${qualified}`;
    let cloneUrl = `https://github.com/${qualified}.git`;
    try {
      const view = await runGh(
        binary,
        ["repo", "view", qualified, "--json", "url,sshUrl,name"],
        { cwd: input.cwd },
      );
      const parsed = JSON.parse(view.stdout) as {
        url?: string;
        sshUrl?: string;
        name?: string;
      };
      if (parsed.url) htmlUrl = parsed.url;
      if (parsed.sshUrl) cloneUrl = parsed.sshUrl;
    } catch {
      /* keep defaults */
    }

    return {
      name: repoName,
      htmlUrl,
      cloneUrl,
      owner,
    };
  }

  /** Create a pull request with `gh pr create`. Returns the PR URL. */
  async createPullRequest(input: {
    cwd: string;
    base: string;
    head: string;
    title: string;
    body?: string;
  }): Promise<{ url: string }> {
    const binary = this.resolveBinary();
    if (!binary) {
      throw new AppError({
        code: "NOT_FOUND",
        userMessage: "GitHub CLI (gh) is not installed.",
        technicalDetail: "gh binary missing",
      });
    }

    const status = await this.status();
    if (!status.authenticated) {
      throw new AppError({
        code: "PERMISSION_DENIED",
        userMessage: "GitHub CLI is not authenticated. Run: gh auth login",
        technicalDetail: status.detail ?? "unauthenticated",
      });
    }

    const args = [
      "pr",
      "create",
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title.trim() || input.head,
      "--body",
      input.body?.trim() || "",
    ];
    const result = await runGh(binary, args, { cwd: input.cwd });
    const url =
      result.stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => /^https?:\/\//i.test(l)) ?? result.stdout.trim();
    if (!url) {
      throw new AppError({
        code: "PROVIDER_ERROR",
        userMessage: "Pull request was created but no URL was returned.",
        technicalDetail: result.stdout.slice(0, 400),
      });
    }
    return { url };
  }
}

function runGhSpawn(
  binary: string,
  args: string[],
  opts: {
    signal?: AbortSignal;
    timeoutMs: number;
    stdin?: string;
    /** Leave stdin open (web device flow waits without needing input). */
    keepStdinOpen?: boolean;
    onChunk?: (chunk: string) => void;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(
        new AppError({
          code: "VALIDATION_ERROR",
          userMessage: "GitHub sign-in was cancelled.",
          technicalDetail: "aborted",
        }),
      );
      return;
    }

    const child = spawn(binary, args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      finish(
        new AppError({
          code: "VALIDATION_ERROR",
          userMessage: "GitHub sign-in was cancelled.",
          technicalDetail: "aborted",
        }),
      );
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        new AppError({
          code: "PROVIDER_TIMEOUT",
          userMessage: "GitHub sign-in timed out.",
          technicalDetail: "login timeout",
        }),
      );
    }, opts.timeoutMs);

    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const handleChunk = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = String(chunk);
      if (stream === "stdout") stdout += text;
      else stderr += text;
      opts.onChunk?.(text);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      handleChunk("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      handleChunk("stderr", chunk);
    });

    child.on("error", (error) => {
      finish(
        new AppError({
          code: "PROVIDER_ERROR",
          userMessage: summarizeGhError(error.message),
          technicalDetail: error.message,
        }),
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish(null);
        return;
      }
      const detail = [stderr, stdout].filter(Boolean).join("\n").trim();
      finish(
        new AppError({
          code: "PROVIDER_ERROR",
          userMessage: summarizeGhError(detail || `gh ${args.join(" ")} failed`),
          technicalDetail: detail.slice(0, 800) || `exit ${code}`,
        }),
      );
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    } else if (!opts.keepStdinOpen) {
      child.stdin?.end();
    }
  });
}
