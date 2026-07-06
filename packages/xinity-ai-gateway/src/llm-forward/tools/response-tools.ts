import { z } from "zod";
import { fetchWebContent } from "./web-fetch";
import { tool } from "ai";
import { rootLogger } from "../../logger";
import type { SearchProvider } from "./search-types";

const log = rootLogger.child({ name: "response-tools" });

let activeSearchProvider: SearchProvider | null = null;

export function setSearchProvider(provider: SearchProvider | null): void {
  activeSearchProvider = provider;
}

export const RESPONSE_TOOL_NAMES = ["web_search"] as const;
export type ResponseToolName = (typeof RESPONSE_TOOL_NAMES)[number];

export const webSearch = tool({
  description: "Search the web for recent information",
  inputSchema: z.object({
    query: z.string().describe("Query to search for"),
    max_results: z.number().int().min(1).max(10).optional().describe("Maximum results to return"),
  }),
  execute: async ({ query, max_results }: { query: string; max_results?: number }) => {
    if (!activeSearchProvider) {
      return { query, results: [], error: "Web search is not configured on this gateway" };
    }
    try {
      const results = await activeSearchProvider.search(query, max_results ?? 5);
      log.debug({ query, resultCount: results.length }, "Web search");
      return { query, results };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ query, err: message }, "Web search failed");
      return { query, results: [], error: message };
    }
  },
});

export const webFetch = tool({
  description: "Fetch the contents of a URL.",
  inputSchema: z.object({
    url: z.url().describe("URL to fetch contents from"),
    max_chars: z.number().int().min(500).max(20000).optional(),
  }),
  execute: async ({ url, max_chars }) => {
    const result = await fetchWebContent(url, max_chars)
    log.debug({ url }, "Web content fetched");
    return result;
  },
});

// Tools map for AI SDK generateText/streamText
export const responseTools = {
  web_search: webSearch,
  web_fetch: webFetch,
} as const;

export type ResponseTools = typeof responseTools;

