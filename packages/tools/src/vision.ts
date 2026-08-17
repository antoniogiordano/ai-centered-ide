import { z } from "zod";
import type { ToolRegistry, ToolPhase } from "./registry.js";

const ALL_PHASES: ToolPhase[] = [
  "planning",
  "checking",
  "building",
  "testing",
];

/** Formats every mainstream vision endpoint accepts as base64 data URLs. */
const SUPPORTED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const EXTENSION_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Detect the real format from magic bytes, falling back to the extension.
 * Sniffing first matters because e2e runners happily write a PNG to a `.jpg`
 * path, and vision endpoints reject a mismatched media type.
 */
export function sniffImageMime(bytes: Buffer, path: string): string | null {
  if (bytes.length >= 8) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return "image/gif";
    }
    if (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }
  }
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIMES[ext] ?? null;
}

export function registerVisionTools(registry: ToolRegistry): void {
  registry.register({
    name: "read_image",
    description:
      "Look at an image file in the workspace (e2e failure screenshot, mockup, diagram). The pixels are sent to you — describe what you see and act on it. Use this instead of read_file for .png/.jpg/.gif/.webp; read_file would return binary garbage. Typical use: an e2e suite failed, so read the screenshot under cypress/screenshots or test-results to see what the page actually looked like.",
    riskLevel: "safe",
    phases: ALL_PHASES,
    argsSchema: z.object({
      path: z.string().min(1),
      /** Why you are looking, echoed back so the reason survives compaction. */
      reason: z.string().max(500).optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to the image file.",
        },
        reason: {
          type: "string",
          description:
            "Short note on what you are looking for, e.g. 'why the Cypress click was blocked'.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const path = String(args.path);
      const { bytes, totalBytes } = ctx.fs.readBinary(path);
      const mime = sniffImageMime(bytes, path);
      if (!mime || !SUPPORTED_MIMES.has(mime)) {
        return {
          summary: `Not a viewable image: ${path}`,
          output: {
            path,
            totalBytes,
            error:
              "Unsupported image format. Only PNG, JPEG, GIF and WebP can be shown to the model.",
          },
        };
      }
      const label = path.split("/").pop() || path;
      return {
        summary: `Viewing ${label} (${mime}, ${totalBytes} bytes)`,
        output: {
          path,
          mime,
          totalBytes,
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        },
        images: [{ mime, dataBase64: bytes.toString("base64"), label }],
      };
    },
  });
}
