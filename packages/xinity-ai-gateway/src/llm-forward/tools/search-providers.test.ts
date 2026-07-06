import { describe, test, expect, afterEach, spyOn } from "bun:test";
import {
  resolveSearchConfig,
  validateSearchCredential,
  createSearchProvider,
  getSearchProvider,
  type WebSearchProviderName,
} from "./search-providers";

// ---------------------------------------------------------------------------
// resolveSearchConfig
// ---------------------------------------------------------------------------

describe("resolveSearchConfig", () => {
  test("returns null when no search env vars are set", () => {
    expect(resolveSearchConfig({})).toBeNull();
  });

  test("returns provider and credential when both are set", () => {
    expect(resolveSearchConfig({
      WEB_SEARCH_PROVIDER: "google",
      WEB_SEARCH_CREDENTIAL: "key:cx",
    })).toEqual({ provider: "google", credential: "key:cx" });
  });

  test("falls back to searxng when only WEB_SEARCH_ENGINE_URL is set", () => {
    expect(resolveSearchConfig({
      WEB_SEARCH_ENGINE_URL: "http://localhost:6148/",
    })).toEqual({ provider: "searxng", credential: "http://localhost:6148/" });
  });

  test("WEB_SEARCH_PROVIDER takes precedence over WEB_SEARCH_ENGINE_URL", () => {
    expect(resolveSearchConfig({
      WEB_SEARCH_PROVIDER: "brave",
      WEB_SEARCH_CREDENTIAL: "brave-key",
      WEB_SEARCH_ENGINE_URL: "http://localhost:6148/",
    })).toEqual({ provider: "brave", credential: "brave-key" });
  });

  test("throws when WEB_SEARCH_PROVIDER is set without WEB_SEARCH_CREDENTIAL", () => {
    expect(() => resolveSearchConfig({
      WEB_SEARCH_PROVIDER: "bing",
    })).toThrow("WEB_SEARCH_CREDENTIAL must be set");
  });
});

// ---------------------------------------------------------------------------
// validateSearchCredential
// ---------------------------------------------------------------------------

describe("validateSearchCredential", () => {
  describe("searxng", () => {
    test("accepts a valid URL", () => {
      expect(() => validateSearchCredential("searxng", "http://localhost:6148/")).not.toThrow();
    });

    test("rejects a non-URL string", () => {
      expect(() => validateSearchCredential("searxng", "not-a-url")).toThrow("valid URL");
    });
  });

  describe("google", () => {
    test("accepts apikey:cx format", () => {
      expect(() => validateSearchCredential("google", "AIzaKey:017576662512468239146:omuauf_gy1")).not.toThrow();
    });

    test("rejects a string without colon", () => {
      expect(() => validateSearchCredential("google", "no-colon")).toThrow("apikey:cx");
    });

    test("rejects empty key (colon at start)", () => {
      expect(() => validateSearchCredential("google", ":cx-only")).toThrow("apikey:cx");
    });

    test("rejects empty cx (colon at end)", () => {
      expect(() => validateSearchCredential("google", "key-only:")).toThrow("apikey:cx");
    });
  });

  const apiKeyProviders: WebSearchProviderName[] = ["bing", "brave", "serper"];
  for (const provider of apiKeyProviders) {
    describe(provider, () => {
      test("accepts a non-empty API key", () => {
        expect(() => validateSearchCredential(provider, "abc123")).not.toThrow();
      });

      test("rejects an empty string", () => {
        expect(() => validateSearchCredential(provider, "")).toThrow("non-empty");
      });

      test("rejects a whitespace-only string", () => {
        expect(() => validateSearchCredential(provider, "   ")).toThrow("non-empty");
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Provider response parsing (spyOn fetch)
// ---------------------------------------------------------------------------

function mockFetch(body: unknown, status = 200) {
  return spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  );
}

afterEach(() => {
  (globalThis.fetch as ReturnType<typeof spyOn>)?.mockRestore?.();
});

describe("createSearchProvider", () => {
  describe("searxng", () => {
    test("maps results correctly", async () => {
      mockFetch({
        results: [
          { title: "Example", url: "https://example.com", content: "A test", score: 0.9, engine: "google" },
        ],
      });
      const provider = createSearchProvider("searxng", "http://localhost:6148/");
      const results = await provider.search("test", 5);
      expect(results).toEqual([{ title: "Example", url: "https://example.com", content: "A test" }]);
    });

    test("handles empty results", async () => {
      mockFetch({ results: [] });
      const provider = createSearchProvider("searxng", "http://localhost:6148/");
      expect(await provider.search("test", 5)).toEqual([]);
    });

    test("handles missing results field", async () => {
      mockFetch({});
      const provider = createSearchProvider("searxng", "http://localhost:6148/");
      expect(await provider.search("test", 5)).toEqual([]);
    });

    test("throws on non-OK response with body detail", async () => {
      mockFetch({ error: "rate limited" }, 429);
      const provider = createSearchProvider("searxng", "http://localhost:6148/");
      await expect(provider.search("test", 5)).rejects.toThrow(/SearXNG search failed \(HTTP 429\)/);
    });

    test("respects maxResults", async () => {
      mockFetch({
        results: [
          { title: "A", url: "https://a.com" },
          { title: "B", url: "https://b.com" },
          { title: "C", url: "https://c.com" },
        ],
      });
      const provider = createSearchProvider("searxng", "http://localhost:6148/");
      const results = await provider.search("test", 2);
      expect(results).toHaveLength(2);
    });
  });

  describe("google", () => {
    test("maps response fields correctly", async () => {
      mockFetch({
        items: [{ title: "Example", link: "https://example.com", snippet: "A snippet" }],
      });
      const provider = createSearchProvider("google", "testkey:testcx");
      const results = await provider.search("test", 5);
      expect(results).toEqual([{ title: "Example", url: "https://example.com", content: "A snippet" }]);
    });

    test("handles missing items field", async () => {
      mockFetch({});
      const provider = createSearchProvider("google", "testkey:testcx");
      expect(await provider.search("test", 5)).toEqual([]);
    });

    test("throws on non-OK response with body detail", async () => {
      mockFetch({ error: { message: "API key invalid" } }, 403);
      const provider = createSearchProvider("google", "testkey:testcx");
      await expect(provider.search("test", 5)).rejects.toThrow(/Google search failed \(HTTP 403\)/);
    });
  });

  describe("bing", () => {
    test("maps response fields correctly", async () => {
      mockFetch({
        webPages: {
          value: [{ name: "Example", url: "https://example.com", snippet: "A snippet" }],
        },
      });
      const provider = createSearchProvider("bing", "test-api-key");
      const results = await provider.search("test", 5);
      expect(results).toEqual([{ title: "Example", url: "https://example.com", content: "A snippet" }]);
    });

    test("handles missing webPages field", async () => {
      mockFetch({});
      const provider = createSearchProvider("bing", "test-api-key");
      expect(await provider.search("test", 5)).toEqual([]);
    });

    test("handles missing value field", async () => {
      mockFetch({ webPages: {} });
      const provider = createSearchProvider("bing", "test-api-key");
      expect(await provider.search("test", 5)).toEqual([]);
    });

    test("throws on non-OK response with body detail", async () => {
      mockFetch({ error: { message: "Invalid subscription key" } }, 401);
      const provider = createSearchProvider("bing", "test-api-key");
      await expect(provider.search("test", 5)).rejects.toThrow(/Bing search failed \(HTTP 401\)/);
    });
  });

  describe("brave", () => {
    test("maps response fields correctly", async () => {
      mockFetch({
        web: {
          results: [{ title: "Example", url: "https://example.com", description: "A description" }],
        },
      });
      const provider = createSearchProvider("brave", "test-api-key");
      const results = await provider.search("test", 5);
      expect(results).toEqual([{ title: "Example", url: "https://example.com", content: "A description" }]);
    });

    test("handles missing web field", async () => {
      mockFetch({});
      const provider = createSearchProvider("brave", "test-api-key");
      expect(await provider.search("test", 5)).toEqual([]);
    });

    test("handles missing results field", async () => {
      mockFetch({ web: {} });
      const provider = createSearchProvider("brave", "test-api-key");
      expect(await provider.search("test", 5)).toEqual([]);
    });

    test("throws on non-OK response with body detail", async () => {
      mockFetch({ error: "too many requests" }, 429);
      const provider = createSearchProvider("brave", "test-api-key");
      await expect(provider.search("test", 5)).rejects.toThrow(/Brave search failed \(HTTP 429\)/);
    });
  });

  describe("serper", () => {
    test("maps response fields correctly", async () => {
      mockFetch({
        organic: [{ title: "Example", link: "https://example.com", snippet: "A snippet" }],
      });
      const provider = createSearchProvider("serper", "test-api-key");
      const results = await provider.search("test", 5);
      expect(results).toEqual([{ title: "Example", url: "https://example.com", content: "A snippet" }]);
    });

    test("handles missing organic field", async () => {
      mockFetch({});
      const provider = createSearchProvider("serper", "test-api-key");
      expect(await provider.search("test", 5)).toEqual([]);
    });

    test("throws on non-OK response with body detail", async () => {
      mockFetch({ message: "Invalid API key" }, 403);
      const provider = createSearchProvider("serper", "test-api-key");
      await expect(provider.search("test", 5)).rejects.toThrow(/Serper search failed \(HTTP 403\)/);
    });
  });
});

// ---------------------------------------------------------------------------
// getSearchProvider (integration)
// ---------------------------------------------------------------------------

describe("getSearchProvider", () => {
  test("returns null when search is not configured", () => {
    expect(getSearchProvider({})).toBeNull();
  });

  test("returns a provider for valid config", () => {
    const provider = getSearchProvider({
      WEB_SEARCH_PROVIDER: "brave",
      WEB_SEARCH_CREDENTIAL: "test-key",
    });
    expect(provider).not.toBeNull();
    expect(typeof provider!.search).toBe("function");
  });

  test("throws on invalid credential", () => {
    expect(() => getSearchProvider({
      WEB_SEARCH_PROVIDER: "google",
      WEB_SEARCH_CREDENTIAL: "no-colon",
    })).toThrow("apikey:cx");
  });

  test("works with legacy WEB_SEARCH_ENGINE_URL", () => {
    const provider = getSearchProvider({
      WEB_SEARCH_ENGINE_URL: "http://localhost:6148/",
    });
    expect(provider).not.toBeNull();
    expect(typeof provider!.search).toBe("function");
  });
});
