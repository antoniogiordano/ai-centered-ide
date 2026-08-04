import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { AppError } from "@ai-ide/shared";
import { GitService } from "./git.js";

const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Sanitize and validate a project folder name (no path segments). */
export function validateProjectName(raw: string): string {
  const name = raw.trim();
  if (!name) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      userMessage: "Project name is required.",
      technicalDetail: "empty project name",
    });
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      userMessage: "Project name cannot contain path separators.",
      technicalDetail: `invalid name: ${name}`,
    });
  }
  if (!PROJECT_NAME_RE.test(name) || name.length > 100) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      userMessage:
        "Use letters, numbers, dots, hyphens, or underscores (max 100 chars).",
      technicalDetail: `invalid name: ${name}`,
    });
  }
  return name;
}

export function resolveProjectPath(parentPath: string, name: string): string {
  const validated = validateProjectName(name);
  const parent = resolve(parentPath);
  if (!isAbsolute(parent)) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      userMessage: "Parent folder must be an absolute path.",
      technicalDetail: parentPath,
    });
  }
  if (!existsSync(parent)) {
    throw new AppError({
      code: "NOT_FOUND",
      userMessage: "Parent folder does not exist.",
      technicalDetail: parent,
    });
  }
  return join(parent, validated);
}

/**
 * Create an empty project directory and `git init -b main`.
 * Does not create README or other scaffold files.
 */
export async function createEmptyProject(
  parentPath: string,
  name: string,
): Promise<string> {
  const projectPath = resolveProjectPath(parentPath, name);
  if (existsSync(projectPath)) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      userMessage: "A folder with that name already exists.",
      technicalDetail: projectPath,
    });
  }
  mkdirSync(projectPath, { recursive: false });
  await new GitService(projectPath).init();
  return projectPath;
}
