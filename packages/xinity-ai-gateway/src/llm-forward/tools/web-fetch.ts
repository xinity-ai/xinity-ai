import { safeFetch } from "./url-safety";

const DEFAULT_MAX_CHARS = 12000;

export type WebFetchResult = {
  url: string;
  content: string;
  truncated: boolean;
  contentType?: string | null;
};

export async function fetchWebContent(
  url: string,
  maxChars = DEFAULT_MAX_CHARS
): Promise<WebFetchResult> {
  const response = await safeFetch(url, {
    headers: { "User-Agent": "xinity-ai-gateway" },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }

  const contentType = response.headers.get("Content-Type");
  const text = await response.text();
  const truncated = text.length > maxChars;

  return {
    url,
    content: text.slice(0, maxChars),
    truncated,
    contentType,
  };
}
