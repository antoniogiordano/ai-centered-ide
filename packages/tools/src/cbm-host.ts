/**
 * Host for codebase-memory-mcp tools (injected by desktop SessionManager).
 */
export type CbmHost = {
  isIndexed(): boolean;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ summary: string; output?: unknown }>;
  /** Compact architecture blurb for system prompt pre-seed. */
  architecturePreseed(): Promise<string | null>;
};
