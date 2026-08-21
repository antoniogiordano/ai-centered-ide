import { describe, expect, it } from "vitest";
import {
  HumanSetupRequestSchema,
  createEmptySessionState,
  humanSetupBlocking,
  humanSetupItemSatisfied,
  humanSetupProgress,
  type HumanSetupItem,
} from "./domain.js";
import { parseEnvKeyPresence, presentEnvKeys } from "./env-keys.js";
import {
  formatHumanSetupResumeMessage,
  isTestGateSyntheticPrompt,
} from "./test-gate.js";

function item(overrides: Partial<HumanSetupItem> = {}): HumanSetupItem {
  return HumanSetupRequestSchema.parse({
    id: "r1",
    reason: "e2e cannot reach the database",
    items: [{ id: "i1", title: "Do the thing", ...overrides }],
    createdAt: new Date().toISOString(),
  }).items[0]!;
}

describe("env key presence", () => {
  it("reports key names and whether they carry a value", () => {
    const content = [
      "# comment",
      "",
      "DATABASE_URL=postgres://x",
      "AUTH_SECRET=",
      'GOOGLE_CLIENT_ID=""',
      "export NEXTAUTH_URL=http://localhost:3000",
      "malformed line",
    ].join("\n");
    expect(parseEnvKeyPresence(content)).toEqual([
      { key: "DATABASE_URL", hasValue: true },
      { key: "AUTH_SECRET", hasValue: false },
      { key: "GOOGLE_CLIENT_ID", hasValue: false },
      { key: "NEXTAUTH_URL", hasValue: true },
    ]);
  });

  it("returns only the requested keys that are filled", () => {
    const content = "DATABASE_URL=postgres://x\nAUTH_SECRET=\n";
    expect(
      presentEnvKeys(content, ["DATABASE_URL", "AUTH_SECRET", "MISSING"]),
    ).toEqual(["DATABASE_URL"]);
  });

  it("treats values copied from a template as not filled", () => {
    const content = [
      'AUTH_SECRET="CHANGE_ME"',
      'GOOGLE_CLIENT_ID="CHANGE_ME.apps.googleusercontent.com"',
      'DATABASE_URL="postgresql://USER:PASSWORD@ep-xxx-pooler.eu.neon.tech/db"',
      "API_KEY=<your-key>",
      "NEXT_PUBLIC_APP_URL=http://localhost:3012",
      "AUTH_TRUST_HOST=true",
    ].join("\n");
    expect(
      presentEnvKeys(content, [
        "AUTH_SECRET",
        "GOOGLE_CLIENT_ID",
        "DATABASE_URL",
        "API_KEY",
        "NEXT_PUBLIC_APP_URL",
        "AUTH_TRUST_HOST",
      ]),
    ).toEqual(["NEXT_PUBLIC_APP_URL", "AUTH_TRUST_HOST"]);
  });

  it("keeps real secrets that merely look random", () => {
    const content = "AUTH_SECRET=Xk9tzQ2p+vB7mNs4rLd8Uh1WcYe6Ja3Kf0Gi5Ob2Tn=\n";
    expect(presentEnvKeys(content, ["AUTH_SECRET"])).toEqual(["AUTH_SECRET"]);
  });
});

describe("human setup items", () => {
  it("satisfies env items only when every key is filled", () => {
    const keys = { envFile: ".env.e2e", envKeys: ["A", "B"] };
    expect(
      humanSetupItemSatisfied(item({ ...keys, envKeysPresent: ["A"] })),
    ).toBe(false);
    expect(
      humanSetupItemSatisfied(item({ ...keys, envKeysPresent: ["A", "B"] })),
    ).toBe(true);
  });

  it("satisfies manual items only when ticked (done is ignored for env items)", () => {
    expect(humanSetupItemSatisfied(item({ done: false }))).toBe(false);
    expect(humanSetupItemSatisfied(item({ done: true }))).toBe(true);
    expect(
      humanSetupItemSatisfied(
        item({ envKeys: ["A"], envKeysPresent: [], done: true }),
      ),
    ).toBe(false);
  });

  it("counts progress and blocks while anything is open", () => {
    const request = HumanSetupRequestSchema.parse({
      id: "r1",
      reason: "why",
      items: [
        { id: "a", title: "env", envFile: ".env", envKeys: ["A"] },
        { id: "b", title: "manual", done: true },
      ],
      createdAt: new Date().toISOString(),
    });
    expect(humanSetupProgress(request)).toEqual({ done: 1, total: 2 });
    expect(humanSetupBlocking(request)).toBe(true);
    expect(humanSetupBlocking(null)).toBe(false);
  });

  it("starts absent on a fresh session", () => {
    expect(createEmptySessionState("s1").humanSetup).toBeNull();
  });
});

describe("formatHumanSetupResumeMessage", () => {
  const request = HumanSetupRequestSchema.parse({
    id: "r1",
    reason: "e2e cannot reach the database",
    items: [
      {
        id: "a",
        title: "Paste the e2e connection string",
        envFile: ".env.e2e",
        envKeys: ["DATABASE_URL"],
        envKeysPresent: ["DATABASE_URL"],
      },
      {
        id: "b",
        title: "Create the Google OAuth client",
        envFile: ".env.local",
        envKeys: ["GOOGLE_CLIENT_ID"],
      },
    ],
    createdAt: new Date().toISOString(),
  });

  it("splits done from missing and names the keys", () => {
    const text = formatHumanSetupResumeMessage(request);
    expect(text).toContain("[IDE · HUMAN SETUP]");
    expect(text).toMatch(/Done:[\s\S]*DATABASE_URL/);
    expect(text).toMatch(/Still missing:[\s\S]*GOOGLE_CLIENT_ID/);
    expect(text).toContain("Do not ask for the same items again");
    expect(isTestGateSyntheticPrompt(text)).toBe(true);
  });

  it("tells the agent to retry when nothing is left", () => {
    const done = {
      ...request,
      items: request.items.map((i) => ({
        ...i,
        envKeysPresent: i.envKeys,
      })),
    };
    const text = formatHumanSetupResumeMessage(done);
    expect(text).toContain("Everything you asked for is in place");
    expect(text).not.toContain("Still missing");
  });

  it("says so when the human skipped", () => {
    expect(formatHumanSetupResumeMessage(request, { skipped: true })).toContain(
      "skipped",
    );
  });
});
