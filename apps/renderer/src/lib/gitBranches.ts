export type GitBranchOption = {
  name: string;
  label: string;
};

/**
 * New-session / switch picker: main/master first so a parallel chat can
 * leave a feat branch, then the current head, then everything else.
 */
export function orderStartBranches(
  current: string | null,
  local: Array<{ name: string }>,
  remoteHeads: Array<{ name: string; remote: string }> = [],
): GitBranchOption[] {
  const localNames = new Set(local.map((b) => b.name));
  const seen = new Set<string>();
  const out: GitBranchOption[] = [];

  const push = (name: string, label: string) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, label });
  };

  for (const preferred of ["main", "master"]) {
    if (localNames.has(preferred) || remoteHeads.some((r) => r.name === preferred)) {
      push(preferred, preferred === current ? `${preferred} (current)` : preferred);
    }
  }

  if (current) push(current, `${current} (current)`);

  for (const branch of local) {
    push(branch.name, branch.name);
  }

  for (const head of remoteHeads) {
    if (localNames.has(head.name) || seen.has(head.name)) continue;
    push(head.name, `${head.name} (${head.remote})`);
  }

  return out;
}

export function conflictResolvePrompt(input: {
  files: string[];
  branch: string | null;
  remote: string | null;
  operation: string;
}): string {
  const files = input.files.length
    ? input.files.map((file) => `- ${file}`).join("\n")
    : "- (git did not list paths; inspect the worktree)";
  const vs = input.remote ? ` vs ${input.remote}` : "";
  return [
    `Resolve the git ${input.operation} conflicts on ${input.branch ?? "HEAD"}${vs}.`,
    "",
    "Conflicted files:",
    files,
    "",
    "Open each file, keep the correct sides, stage the resolutions, and finish the merge or rebase. Do not discard the other side unless it is clearly obsolete.",
  ].join("\n");
}

export function formatAheadBehind(
  ahead: number | null | undefined,
  behind: number | null | undefined,
): string {
  if (ahead == null && behind == null) return "no remote branch";
  const a = ahead ?? 0;
  const b = behind ?? 0;
  if (a === 0 && b === 0) return "even";
  if (a > 0 && b > 0) return `${a} ahead · ${b} behind`;
  if (a > 0) return `${a} ahead`;
  return `${b} behind`;
}
