import { safeFetch } from "./url-safety";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { load as cheerioLoad } from "cheerio";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "web-fetch" });

const DEFAULT_MAX_CHARS = 12000;

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

turndownService.use(gfm);

export type WebFetchResult = {
  url: string;
  content: string;
  title?: string;
  description?: string;
  truncated: boolean;
  success: boolean;
  error?: string;
  contentType?: string | null;
};

function parseHtml(html: string): {
  title?: string;
  description?: string;
  cleanedHtml: string;
} {
  const $ = cheerioLoad(html);

  const result: { title?: string; description?: string; cleanedHtml: string } = { cleanedHtml: "" };

  const title = $("title").text().trim();
  if (title) result.title = title;

  const description =
    $('meta[name="description"]').attr("content") ??
    $('meta[property="og:description"]').attr("content");
  if (description?.trim()) {
    result.description = description.trim();
  }

  $("script, style, noscript").remove();
  result.cleanedHtml = $.html();

  return result;
}

function convertToMarkdown(html: string): string | null {
  try {
    return turndownService.turndown(html);
  } catch (err) {
    log.warn({ err }, "Markdown conversion failed");
    return null;
  }
}

export async function fetchWebContent(
  url: string,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<WebFetchResult> {
  let response;
  try {
    response = await safeFetch(url, {
      headers: { "User-Agent": "xinity-ai-gateway" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.warn({ url, message }, "Fetch failed");
    return {
      url,
      content: "",
      success: false,
      error: message,
      truncated: false,
    };
  }

  if (!response.ok) {
    const message = `Fetch failed: ${response.status}`;
    log.warn({ url, status: response.status }, message);
    return {
      url,
      content: "",
      success: false,
      error: message,
      truncated: false,
    };
  }

  const contentType = response.headers.get("Content-Type");
  const isHtml =
    contentType &&
    (contentType.includes("text/html") ||
      contentType.includes("application/xhtml") ||
      contentType.includes("application/xml"));

  if (!isHtml) {
    const text = await response.text();
    const truncated = text.length > maxChars;
    return {
      url,
      content: text.slice(0, maxChars),
      truncated,
      success: true,
      contentType,
    };
  }

  const text = await response.text();

  const { title, description, cleanedHtml } = parseHtml(text);

  const markdown = convertToMarkdown(cleanedHtml);

  if (!markdown || markdown.trim().length === 0) {
    return {
      url,
      content: "",
      success: false,
      error: "No content extracted",
      truncated: false,
    };
  }

  const truncated = markdown.length > maxChars;

  return {
    url,
    content: markdown.slice(0, maxChars),
    truncated,
    success: true,
    contentType,
    ...(title && { title }),
    ...(description && { description }),
  };
}
