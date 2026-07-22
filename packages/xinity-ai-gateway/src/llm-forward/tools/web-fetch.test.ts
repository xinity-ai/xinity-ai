import { describe, test, expect, mock } from "bun:test";

const _noop = () => {};
const _mockChild = (): Record<string, unknown> => ({ trace: _noop, debug: _noop, info: _noop, warn: _noop, error: _noop, fatal: _noop, child: _mockChild });
mock.module("../../logger", () => ({ rootLogger: { child: _mockChild } }));

function htmlResponse(body: string, contentType = "text/html; charset=utf-8", status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

function textResponse(body: string, contentType = "text/plain", status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

let safeFetchImpl: (url: string, opts?: unknown) => Promise<Response>;

mock.module("./url-safety", () => ({
  safeFetch: (url: string, opts?: unknown) => safeFetchImpl(url, opts),
}));

const { fetchWebContent } = await import("./web-fetch");

describe("fetchWebContent", () => {
  test("converts HTML to markdown and extracts metadata", async () => {
    safeFetchImpl = async () => htmlResponse(`
      <html>
      <head>
        <title>Test Page</title>
        <meta name="description" content="A test description">
      </head>
      <body><h1>Hello</h1><p>World</p></body>
      </html>
    `);

    const result = await fetchWebContent("https://example.com");
    expect(result.success).toBe(true);
    expect(result.title).toBe("Test Page");
    expect(result.description).toBe("A test description");
    expect(result.content).toContain("# Hello");
    expect(result.content).toContain("World");
    expect(result.truncated).toBe(false);
  });

  test("strips script, style, and noscript from HTML", async () => {
    safeFetchImpl = async () => htmlResponse(`
      <html><body>
        <script>alert("xss")</script>
        <style>.x { color: red }</style>
        <noscript>Enable JS</noscript>
        <p>Visible content</p>
      </body></html>
    `);

    const result = await fetchWebContent("https://example.com");
    expect(result.success).toBe(true);
    expect(result.content).not.toContain("alert");
    expect(result.content).not.toContain("color: red");
    expect(result.content).not.toContain("Enable JS");
    expect(result.content).toContain("Visible content");
  });

  test("falls back to OG description when meta description is absent", async () => {
    safeFetchImpl = async () => htmlResponse(`
      <html><head>
        <meta property="og:description" content="OG desc">
      </head><body><p>Content</p></body></html>
    `);

    const result = await fetchWebContent("https://example.com");
    expect(result.description).toBe("OG desc");
  });

  test("returns non-HTML content as-is", async () => {
    safeFetchImpl = async () => textResponse('{"key": "value"}', "application/json");

    const result = await fetchWebContent("https://example.com/data.json");
    expect(result.success).toBe(true);
    expect(result.content).toBe('{"key": "value"}');
    expect(result.title).toBeUndefined();
    expect(result.contentType).toBe("application/json");
  });

  test("truncates non-HTML content to maxChars", async () => {
    safeFetchImpl = async () => textResponse("x".repeat(200), "text/plain");

    const result = await fetchWebContent("https://example.com", 50);
    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(50);
  });

  test("truncates HTML-derived markdown to maxChars", async () => {
    const longText = "word ".repeat(5000);
    safeFetchImpl = async () => htmlResponse(`<html><body><p>${longText}</p></body></html>`);

    const result = await fetchWebContent("https://example.com", 100);
    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(100);
  });

  test("returns success:false on HTTP error status", async () => {
    safeFetchImpl = async () => new Response("Not Found", { status: 404 });

    const result = await fetchWebContent("https://example.com/missing");
    expect(result.success).toBe(false);
    expect(result.error).toContain("404");
    expect(result.content).toBe("");
  });

  test("returns success:false when fetch throws", async () => {
    safeFetchImpl = async () => { throw new Error("URL blocked: Blocked hostname: localhost"); };

    const result = await fetchWebContent("http://localhost/secret");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Blocked hostname");
    expect(result.content).toBe("");
  });

  test("returns success:false when HTML yields no extractable content", async () => {
    safeFetchImpl = async () => htmlResponse("<html><body></body></html>");

    const result = await fetchWebContent("https://example.com/empty");
    expect(result.success).toBe(false);
    expect(result.error).toContain("No content extracted");
  });

  test("handles GFM tables in HTML", async () => {
    safeFetchImpl = async () => htmlResponse(`
      <html><body>
        <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      </body></html>
    `);

    const result = await fetchWebContent("https://example.com");
    expect(result.success).toBe(true);
    expect(result.content).toContain("| A | B |");
    expect(result.content).toContain("| 1 | 2 |");
  });
});
