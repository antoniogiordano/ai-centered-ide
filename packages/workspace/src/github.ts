import { AppError } from "@ai-ide/shared";

export const GITHUB_CREDENTIAL_ACCOUNT = "github";
export const GITHUB_OAUTH_SCOPE = "repo";

export type DeviceFlowStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Prefer opening this in the browser when present (includes user_code). */
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
};

export type GithubRepo = {
  name: string;
  htmlUrl: string;
  cloneUrl: string;
  private: boolean;
};

export type GithubUser = {
  login: string;
};

type FetchFn = typeof fetch;

function formBody(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AppError({
      code: "PROVIDER_ERROR",
      userMessage: "GitHub returned an unexpected response.",
      technicalDetail: text.slice(0, 500),
    });
  }
}

export class GithubClient {
  constructor(private readonly fetchImpl: FetchFn = fetch) {}

  async startDeviceFlow(clientId: string): Promise<DeviceFlowStart> {
    const res = await this.fetchImpl("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody({
        client_id: clientId,
        scope: GITHUB_OAUTH_SCOPE,
      }),
    });
    const data = await parseJson(res);
    if (!res.ok || typeof data.device_code !== "string") {
      throw new AppError({
        code: "PROVIDER_ERROR",
        userMessage:
          typeof data.error_description === "string"
            ? data.error_description
            : "Could not start GitHub sign-in.",
        technicalDetail: JSON.stringify(data).slice(0, 500),
      });
    }
    return {
      deviceCode: data.device_code,
      userCode: String(data.user_code ?? ""),
      verificationUri: String(
        data.verification_uri ?? "https://github.com/login/device",
      ),
      verificationUriComplete:
        typeof data.verification_uri_complete === "string"
          ? data.verification_uri_complete
          : null,
      expiresIn: Number(data.expires_in ?? 900),
      interval: Number(data.interval ?? 5),
    };
  }

  /**
   * Poll until the user completes device authorization or the flow expires.
   * Pass an AbortSignal to cancel.
   */
  async pollAccessToken(
    clientId: string,
    deviceCode: string,
    intervalSec: number,
    signal?: AbortSignal,
  ): Promise<string> {
    let intervalMs = Math.max(0, intervalSec) * 1000;
    const started = Date.now();
    const maxMs = 15 * 60 * 1000;

    while (Date.now() - started < maxMs) {
      if (signal?.aborted) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          userMessage: "GitHub sign-in was cancelled.",
          technicalDetail: "aborted",
        });
      }

      await sleep(intervalMs, signal);

      const res = await this.fetchImpl(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formBody({
            client_id: clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
          ...(signal ? { signal } : {}),
        },
      );
      const data = await parseJson(res);

      if (typeof data.access_token === "string" && data.access_token) {
        return data.access_token;
      }

      const err = String(data.error ?? "");
      if (err === "authorization_pending") {
        continue;
      }
      if (err === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      if (err === "expired_token") {
        throw new AppError({
          code: "PROVIDER_TIMEOUT",
          userMessage: "GitHub sign-in expired. Start again.",
          technicalDetail: err,
        });
      }
      if (err === "access_denied") {
        throw new AppError({
          code: "PERMISSION_DENIED",
          userMessage: "GitHub sign-in was denied.",
          technicalDetail: err,
        });
      }
      throw new AppError({
        code: "PROVIDER_ERROR",
        userMessage:
          typeof data.error_description === "string"
            ? data.error_description
            : "GitHub sign-in failed.",
        technicalDetail: JSON.stringify(data).slice(0, 500),
      });
    }

    throw new AppError({
      code: "PROVIDER_TIMEOUT",
      userMessage: "GitHub sign-in timed out.",
      technicalDetail: "poll timeout",
    });
  }

  async getAuthenticatedUser(token: string): Promise<GithubUser> {
    const res = await this.fetchImpl("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-centered-ide",
      },
    });
    const data = await parseJson(res);
    if (!res.ok || typeof data.login !== "string") {
      throw new AppError({
        code: "PROVIDER_ERROR",
        userMessage: "Could not verify GitHub credentials.",
        technicalDetail: JSON.stringify(data).slice(0, 500),
      });
    }
    return { login: data.login };
  }

  async createRepo(
    token: string,
    input: { name: string; private?: boolean },
  ): Promise<GithubRepo> {
    const res = await this.fetchImpl("https://api.github.com/user/repos", {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-centered-ide",
      },
      body: JSON.stringify({
        name: input.name,
        private: input.private ?? true,
        auto_init: false,
      }),
    });
    const data = await parseJson(res);
    if (!res.ok) {
      const msg =
        typeof data.message === "string"
          ? data.message
          : "Could not create GitHub repository.";
      throw new AppError({
        code: res.status === 422 ? "VALIDATION_ERROR" : "PROVIDER_ERROR",
        userMessage: msg,
        technicalDetail: JSON.stringify(data).slice(0, 500),
      });
    }
    return {
      name: String(data.name ?? input.name),
      htmlUrl: String(data.html_url ?? ""),
      cloneUrl: String(data.clone_url ?? data.ssh_url ?? ""),
      private: Boolean(data.private),
    };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new AppError({
          code: "VALIDATION_ERROR",
          userMessage: "GitHub sign-in was cancelled.",
          technicalDetail: "aborted",
        }),
      );
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new AppError({
          code: "VALIDATION_ERROR",
          userMessage: "GitHub sign-in was cancelled.",
          technicalDetail: "aborted",
        }),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
