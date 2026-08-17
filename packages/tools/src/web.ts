import { z } from "zod";
import type { ToolRegistry, ToolPhase } from "./registry.js";

const ALL_PHASES: ToolPhase[] = [
  "planning",
  "checking",
  "building",
  "testing",
];

const MAX_FETCH_CHARS = 40_000;
const FETCH_TIMEOUT_MS = 20_000;

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
]);

function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  // Prefer https; allow http only for localhost-like (already blocked) — require https.
  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS URLs are allowed for web_fetch / web_search.");
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Host not allowed: ${host}`);
  }
  // Block obvious private IPv4.
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.)/.test(host)) {
    throw new Error(`Private IP host not allowed: ${host}`);
  }
  return url;
}

function htmlToRoughText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchUrlText(
  url: string,
  maxChars: number,
): Promise<{ finalUrl: string; contentType: string; text: string }> {
  const parsed = assertPublicHttpsUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept:
          "text/plain,text/markdown,text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "User-Agent": "ai-first-ide-web-fetch/0.1",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${parsed.toString()}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    const text =
      /html/i.test(contentType) || /<!DOCTYPE html|<html[\s>]/i.test(raw)
        ? htmlToRoughText(raw)
        : raw.replace(/\r\n/g, "\n");
    return {
      finalUrl: response.url || parsed.toString(),
      contentType,
      text: text.slice(0, maxChars),
    };
  } finally {
    clearTimeout(timer);
  }
}

type SearchHit = { title: string; url: string; snippet: string };

function parseDuckDuckGoHits(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const re =
    /<a[^>]+rel="nofollow"[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td)>)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < limit) {
    const href = m[1] ?? "";
    const title = htmlToRoughText(m[2] ?? "").trim();
    const snippet = htmlToRoughText(m[3] ?? "").trim();
    let url = href;
    // DDG sometimes wraps redirects.
    try {
      const u = new URL(href, "https://duckduckgo.com");
      const uddg = u.searchParams.get("uddg");
      if (uddg) url = decodeURIComponent(uddg);
    } catch {
      /* keep href */
    }
    if (!title || !url.startsWith("http")) continue;
    hits.push({ title, url, snippet: snippet.slice(0, 280) });
  }
  return hits;
}

export async function webFetchPage(
  url: string,
  maxChars = MAX_FETCH_CHARS,
): Promise<{ finalUrl: string; contentType: string; text: string; truncated: boolean }> {
  const result = await fetchUrlText(url, maxChars);
  return {
    ...result,
    truncated: result.text.length >= maxChars,
  };
}

export async function webSearchQuery(
  query: string,
  limit = 8,
): Promise<{ query: string; hits: SearchHit[] }> {
  const q = query.trim();
  if (!q) throw new Error("query is required");
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const parsed = assertPublicHttpsUrl(searchUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let rawHtml = "";
  try {
    const response = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html",
        "User-Agent": "ai-first-ide-web-search/0.1",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} searching for “${q}”`);
    }
    rawHtml = await response.text();
  } finally {
    clearTimeout(timer);
  }
  const hits = parseDuckDuckGoHits(rawHtml, Math.min(20, Math.max(1, limit)));
  return { query: q, hits };
}

export function registerWebTools(registry: ToolRegistry): void {
  registry.register({
    name: "web_fetch",
    description:
      "Fetch a public HTTPS URL and return plain text (HTML stripped). Prefer this for library docs / GitHub README / npm package pages instead of reverse-engineering APIs from node_modules. Examples: https://raw.githubusercontent.com/OWNER/REPO/HEAD/README.md or the package docs URL.",
    riskLevel: "safe",
    phases: ALL_PHASES,
    argsSchema: z.object({
      url: z.string().url(),
      maxChars: z.number().int().positive().max(80_000).optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "HTTPS URL to fetch (README, docs page, raw.githubusercontent.com, …)",
        },
        maxChars: {
          type: "integer",
          description: `Max characters to return (default ${MAX_FETCH_CHARS})`,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const url = String(args.url ?? "");
      const maxChars =
        typeof args.maxChars === "number" ? args.maxChars : MAX_FETCH_CHARS;
      const page = await webFetchPage(url, maxChars);
      return {
        summary: `Fetched ${page.finalUrl} (${page.text.length} chars${page.truncated ? ", truncated" : ""})`,
        output: page,
      };
    },
  });

  registry.register({
    name: "web_search",
    description:
      "Search the public web for docs (DuckDuckGo HTML). Use to find the official README / docs URL for a library (e.g. \"react-joyride github readme\"), then follow up with web_fetch on the best hit. Prefer docs over guessing from source.",
    riskLevel: "safe",
    phases: ALL_PHASES,
    argsSchema: z.object({
      query: z.string().min(1).max(300),
      limit: z.number().int().positive().max(20).optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'Search query, e.g. "react-joyride npm readme"',
        },
        limit: {
          type: "integer",
          description: "Max results (default 8)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const query = String(args.query ?? "");
      const limit = typeof args.limit === "number" ? args.limit : 8;
      const result = await webSearchQuery(query, limit);
      return {
        summary: `Search “${result.query}”: ${result.hits.length} hit(s)`,
        output: result,
      };
    },
  });
}
