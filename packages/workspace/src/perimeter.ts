import { existsSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { AppError } from "@ai-ide/shared";

export function assertInsideWorkspace(
  workspaceRoot: string,
  candidatePath: string,
): string {
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(resolve(workspaceRoot));
  } catch (error) {
    throw new AppError({
      code: "WORKSPACE_OUTSIDE",
      userMessage: "The requested path is outside the workspace.",
      technicalDetail: `Failed to resolve workspace root: ${workspaceRoot}`,
      cause: error,
    });
  }

  const absoluteCandidate = resolve(workspaceRoot, candidatePath);

  if (existsSync(absoluteCandidate)) {
    try {
      const resolvedCandidate = realpathSync(absoluteCandidate);
      if (!isInsideResolvedRoot(resolvedRoot, resolvedCandidate)) {
        throw outsideError(resolvedCandidate, resolvedRoot);
      }
      return resolvedCandidate;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError({
        code: "WORKSPACE_OUTSIDE",
        userMessage: "The requested path is outside the workspace.",
        technicalDetail: `Failed to resolve path: ${candidatePath}`,
        cause: error,
      });
    }
  }

  const rel = relative(resolve(workspaceRoot), absoluteCandidate);
  if (rel.startsWith("..") || rel.split(sep).includes("..") || rel.startsWith(`..${sep}`)) {
    throw new AppError({
      code: "WORKSPACE_OUTSIDE",
      userMessage: "Path traversal is not allowed.",
      technicalDetail: candidatePath,
    });
  }

  const resolvedCandidate = join(resolvedRoot, rel);
  if (!isInsideResolvedRoot(resolvedRoot, resolvedCandidate)) {
    throw outsideError(resolvedCandidate, resolvedRoot);
  }

  return resolvedCandidate;
}

function isInsideResolvedRoot(resolvedRoot: string, resolvedCandidate: string): boolean {
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."));
}

function outsideError(resolvedCandidate: string, resolvedRoot: string): AppError {
  return new AppError({
    code: "WORKSPACE_OUTSIDE",
    userMessage: "The requested path is outside the workspace.",
    technicalDetail: `${resolvedCandidate} is not under ${resolvedRoot}`,
  });
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
): string {
  return assertInsideWorkspace(workspaceRoot, relativePath);
}
