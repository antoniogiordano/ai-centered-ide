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
  upsert_architecture: "safe",
  read_architecture: "safe",
  git_commit: "sensitive",
  run_command: "sensitive",
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

export function analyzeCommand(command: string): {
  blocked: boolean;
  needsApproval: boolean;
  matchedDeny?: string;
  allowlisted: boolean;
} {
  const normalized = command.trim().toLowerCase();
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
