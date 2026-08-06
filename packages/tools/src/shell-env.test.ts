import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrichShellEnv,
  interactiveToolchainBootstrap,
  wrapUnixLoginCommand,
} from "./shell-env.js";

describe("shell-env", () => {
  it("enrichShellEnv prepends common tool paths", () => {
    const env = enrichShellEnv("/tmp", { PATH: "/usr/bin", HOME: process.env.HOME });
    expect(env.PATH?.split(":")).toEqual(
      expect.arrayContaining(["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"]),
    );
    expect(env.TERM).toBe("xterm-256color");
  });

  it("wrapUnixLoginCommand sources nvm and uses pin when .nvmrc exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-ide-nvm-"));
    writeFileSync(join(dir, ".nvmrc"), "18.20.0\n");
    const wrapped = wrapUnixLoginCommand("node --version", dir);
    expect(wrapped).toContain("nvm.sh");
    expect(wrapped).toContain("nvm use");
    expect(wrapped).toContain("node --version");
  });

  it("interactiveToolchainBootstrap mentions node banner", () => {
    const snippet = interactiveToolchainBootstrap("/tmp");
    expect(snippet).toContain("nvm.sh");
    expect(snippet).toContain("[ai-ide] node");
  });
});
