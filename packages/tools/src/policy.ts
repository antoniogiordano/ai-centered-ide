import type { AgentMode, ApprovalGrant, RiskLevel } from "@ai-ide/shared";

export type ApprovalCategory =
  | "command"
  | "network"
  | "destructive"
  | "env_write"
  | "git_commit";

export type ApprovalRequest = {
  id: string;
  toolName: string;
  category: ApprovalCategory;
  description: string;
  riskLevel: RiskLevel;
};

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string }
  | { allowed: false; requiresApproval: true; category: ApprovalCategory; description: string };

const TOOL_RISK: Record<string, RiskLevel> = {
  read_file: "safe",
  list_dir: "safe",
  search_text: "safe",
  git_status: "safe",
  git_diff: "safe",
  write_file: "reversible",
  replace_in_file: "reversible",
  import_attachment: "safe",
  upsert_architecture: "safe",
  read_architecture: "safe",
  web_fetch: "safe",
  web_search: "safe",
  read_image: "safe",
  ask_user: "safe",
  git_commit: "sensitive",
  run_command: "sensitive",
  get_test_report: "safe",
  list_failed_tests: "safe",
  read_test_log: "safe",
  terminal_open: "safe",
  terminal_list: "safe",
  terminal_read: "safe",
  terminal_write: "reversible",
  terminal_ask: "reversible",
  terminal_close: "safe",
  checkpoint_restore: "reversible",
};

export function getToolRisk(toolName: string): RiskLevel {
  return TOOL_RISK[toolName] ?? "sensitive";
}

type ModeMatrix = Record<RiskLevel, "allow" | "deny" | "approve">;

const MODE_POLICY: Record<AgentMode, ModeMatrix> = {
  ask: {
    safe: "allow",
    reversible: "deny",
    sensitive: "deny",
    destructive: "deny",
  },
  plan: {
    safe: "allow",
    reversible: "deny",
    sensitive: "approve",
    destructive: "deny",
  },
  agent: {
    safe: "allow",
    reversible: "allow",
    sensitive: "approve",
    destructive: "approve",
  },
  autonomous: {
    safe: "allow",
    reversible: "allow",
    sensitive: "allow",
    destructive: "approve",
  },
};

export function evaluatePolicy(params: {
  mode: AgentMode;
  toolName: string;
  riskLevel?: RiskLevel;
  grants: ApprovalGrant[];
  category?: ApprovalCategory;
}): PolicyDecision {
  const risk = params.riskLevel ?? getToolRisk(params.toolName);
  const rule = MODE_POLICY[params.mode][risk];

  if (rule === "allow") return { allowed: true };
  if (rule === "deny") {
    return {
      allowed: false,
      reason: `Tool ${params.toolName} is not allowed in ${params.mode} mode.`,
    };
  }

  if (params.category && params.grants.some((g) => g.category === params.category)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    requiresApproval: true,
    category: params.category ?? "command",
    description: `Approval required for ${params.toolName} (${risk}).`,
  };
}

export const READONLY_COMMAND_ALLOWLIST = [
  "ls",
  "cat",
  "pwd",
  "echo",
  "git status",
  "git diff",
  "git log",
  "npm test",
  "pnpm test",
  "node --version",
];

export const COMMAND_DENYLIST = [
  "rm -rf",
  "rm -fr",
  "git push",
  "git push --force",
  "git reset --hard",
  "sudo",
  "chmod 777",
  "docker volume rm",
  "mkfs",
  ":(){ :|:& };:",
];

/**
 * Git write ops that only the harness UI may perform (Commit Build /
 * Integrate banners). Matched with flexible whitespace so
 * `git  commit` / multiline terminal paste still block.
 */
const HARNESS_ONLY_GIT_RE =
  /\bgit\s+(commit|push|rebase|am|cherry-pick)(?:\s|$)/i;

export function analyzeCommand(command: string): {
  blocked: boolean;
  needsApproval: boolean;
  matchedDeny?: string;
  allowlisted: boolean;
} {
  const normalized = command.trim().toLowerCase();
  const harnessGit = HARNESS_ONLY_GIT_RE.exec(command);
  if (harnessGit) {
    return {
      blocked: true,
      needsApproval: true,
      matchedDeny: `git ${harnessGit[1]!.toLowerCase()}`,
      allowlisted: false,
    };
  }
  for (const denied of COMMAND_DENYLIST) {
    if (normalized.includes(denied.toLowerCase())) {
      return { blocked: true, needsApproval: true, matchedDeny: denied, allowlisted: false };
    }
  }
  const allowlisted = READONLY_COMMAND_ALLOWLIST.some((allowed) =>
    normalized.startsWith(allowed.toLowerCase()),
  );
  if (allowlisted) {
    return { blocked: false, needsApproval: false, allowlisted: true };
  }
  if (/&&|\||;|`|\$\(/.test(normalized)) {
    return { blocked: false, needsApproval: true, allowlisted: false };
  }
  return { blocked: false, needsApproval: true, allowlisted: false };
}

const SHELL_FILE_INSPECT_BIN = new Set([
  "cat",
  "ls",
  "ll",
  "la",
  "dir",
  "tree",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "tac",
  "find",
  "stat",
  "file",
  "wc",
]);

/**
 * True when the shell is being used as a file browser (cat/ls/find/…).
 * Those belong to list_dir / read_file / search_* / search_graph instead.
 */
export function isShellFileInspectionCommand(command: string): boolean {
  const segments = command
    .split(/(?:&&|\|\||;|\n)/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;

  let sawInspect = false;
  for (const segment of segments) {
    // Drop leading env assignments: FOO=1 BAR=2 cmd …
    const withoutEnv = segment.replace(/^(?:\w+=\S+\s+)+/, "").trim();
    // Drop pipe receiver focus: only look at the head of each segment.
    const head = withoutEnv.split("|")[0]?.trim() ?? "";
    const rawToken = head.split(/\s+/)[0] ?? "";
    const token = rawToken.replace(/^.*[/\\]/, "").toLowerCase();
    if (!token) continue;
    if (SHELL_FILE_INSPECT_BIN.has(token)) {
      sawInspect = true;
      continue;
    }
    // echo / true between cats still counts as inspection chain if we saw inspect.
    if (token === "echo" || token === "printf" || token === "true" || token === ":") {
      continue;
    }
    // Mixed with a real command (e.g. npm) — not pure file inspection.
    return false;
  }
  return sawInspect;
}
