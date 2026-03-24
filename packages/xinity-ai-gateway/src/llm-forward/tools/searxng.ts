import { env } from "../../env";

export type SearxngResult = {
  title: string;
  url: string;
  content?: string;
  score?: number;
  engine?: string;
};

export async function searchSearxng(query: string, maxResults = 5): Promise<SearxngResult[]> {
  if (!env.WEB_SEARCH_ENGINE_URL) {
    throw new Error("env.WEB_SEARCH_ENGINE_URL is not configured");
  }

  const baseUrl = new URL(env.WEB_SEARCH_ENGINE_URL);
  const path = baseUrl.pathname.endsWith("/")
    ? `${baseUrl.pathname}search`
    : `${baseUrl.pathname}/search`;
  baseUrl.pathname = path;
  baseUrl.searchParams.set("q", query);
  baseUrl.searchParams.set("format", "json");

  const response = await fetch(baseUrl.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Search request failed: ${response.status}`);
  }

  const payload = (await response.json()) as { results?: any[] };
  const results = payload.results ?? [];

  return results.slice(0, maxResults).map(result => ({
    title: result.title,
    url: result.url,
    content: result.content,
    score: result.score,
    engine: result.engine,
  }));
}
