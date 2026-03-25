import { z } from "zod";
import { searchSearxng } from "./searxng";
import { fetchWebContent } from "./web-fetch";
import { tool } from "ai";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "response-tools" });

export const RESPONSE_TOOL_NAMES = ["web_search", "web_fetch"] as const;
export type ResponseToolName = (typeof RESPONSE_TOOL_NAMES)[number];

export const webSearch = tool({
  description: "Search the web for recent information",
  inputSchema: z.object({
    query: z.string().describe("Query to search for"),
    max_results: z.number().int().min(1).max(10).optional().describe("Maximum results to return"),
  }),
  execute: async ({ query, max_results }: { query: string; max_results?: number }) => {
    const results = await searchSearxng(query, max_results ?? 5);
    log.debug({ query, resultCount: results.length }, "Web search");
    return { query, results };
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

