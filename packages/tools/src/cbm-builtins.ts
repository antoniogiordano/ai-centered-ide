import { z } from "zod";
import type { ToolRegistry, ToolPhase } from "./registry.js";

const READ_PHASES: ToolPhase[] = ["planning", "building", "testing"];

const CBM_MODEL_TOOLS: Array<{
  name: string;
  description: string;
  required?: string[];
  properties: Record<string, unknown>;
}> = [
  {
    name: "search_graph",
    description:
      "PRIMARY explore tool when indexed: search the codebase graph (functions, classes, components, routes) by keyword. Prefer over list_dir for discovery. Typical limit 10–20.",
    properties: {
      query: { type: "string", description: "Keyword / BM25 query" },
      label: { type: "string" },
      name_pattern: { type: "string" },
      qn_pattern: { type: "string" },
      file_pattern: { type: "string" },
      limit: { type: "integer" },
      offset: { type: "integer" },
    },
  },
  {
    name: "trace_path",
    description:
      "BFS call graph from a symbol: callers/callees (depth 1–5). Prefer after search_graph finds a qualified_name.",
    properties: {
      function_name: { type: "string" },
      qualified_name: { type: "string" },
      direction: { type: "string", description: "up | down | both" },
      depth: { type: "integer" },
    },
  },
  {
    name: "get_code_snippet",
    description:
      "Fetch source for a symbol by qualified_name (from search_graph). Prefer over read_file when you have a graph hit.",
    required: ["qualified_name"],
    properties: {
      qualified_name: { type: "string" },
      include_neighbors: { type: "boolean" },
    },
  },
  {
    name: "get_architecture",
    description:
      "Indexed architecture overview: languages, packages, routes, hotspots. Prefer early in a chat instead of walking dirs with list_dir.",
    properties: {},
  },
  {
    name: "search_code",
    description:
      "Indexed text search (grep-like). Prefer over search_text / repeated list_dir when looking for symbols or strings.",
    properties: {
      query: { type: "string" },
      pattern: { type: "string" },
      file_pattern: { type: "string" },
      limit: { type: "integer" },
    },
  },
  {
    name: "get_graph_schema",
    description:
      "Graph schema: labels, relationship patterns, property keys. Call before complex searches.",
    properties: {},
  },
  {
    name: "detect_changes",
    description:
      "Map git diff to impacted symbols and blast radius / risk.",
    properties: {
      since: { type: "string" },
    },
  },
];

export function registerCbmTools(registry: ToolRegistry): void {
  for (const tool of CBM_MODEL_TOOLS) {
    const required = tool.required ?? [];
    registry.register({
      name: tool.name,
      description: tool.description,
      riskLevel: "safe",
      phases: READ_PHASES,
      argsSchema: z.record(z.unknown()) as z.ZodType<Record<string, unknown>>,
      parameters: {
        type: "object",
        properties: tool.properties,
        ...(required.length ? { required } : {}),
        additionalProperties: true,
      },
      execute: async (args, ctx) => {
        if (!ctx.cbm) {
          throw new Error(
            "Codebase memory engine is not available. Index the project or use filesystem tools.",
          );
        }
        if (!ctx.cbm.isIndexed()) {
          throw new Error(
            "Codebase is not indexed yet. Ask the user to index the project from the engine banner.",
          );
        }
        return ctx.cbm.callTool(tool.name, args);
      },
    });
  }
}

export const CBM_TOOL_NAMES = CBM_MODEL_TOOLS.map((t) => t.name);
export const FS_READ_TOOL_NAMES = ["list_dir", "read_file", "search_text"] as const;
