import type { SearchProvider } from "./search-types";

const SEARCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function failedSearchResponse(provider: string, res: Response): Promise<never> {
  let detail = "";
  try {
    const body = await res.text();
    if (body) {
      detail = `: ${body.slice(0, 200)}`;
    }
  } catch {}
  throw new Error(`${provider} search failed (HTTP ${res.status})${detail}`);
}

// ---------------------------------------------------------------------------
// Provider factories
// ---------------------------------------------------------------------------

function createSearxngProvider(credential: string): SearchProvider {
  const baseUrl = new URL(credential);
  return {
    async search(query, maxResults) {
      const url = new URL(baseUrl);
      url.pathname = url.pathname.replace(/\/$/, "") + "/search";
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const res = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
      if (!res.ok) {
        await failedSearchResponse("SearXNG", res);
      }
      const payload = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
      return (payload.results ?? []).slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
      }));
    },
  };
}

function createGoogleProvider(credential: string): SearchProvider {
  const idx = credential.indexOf(":");
  const apiKey = credential.slice(0, idx);
  const cx = credential.slice(idx + 1);
  return {
    async search(query, maxResults) {
      const url = new URL("https://www.googleapis.com/customsearch/v1");
      url.searchParams.set("key", apiKey);
      url.searchParams.set("cx", cx);
      url.searchParams.set("q", query);
      url.searchParams.set("num", String(Math.min(maxResults, 10)));
      const res = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
      if (!res.ok) {
        await failedSearchResponse("Google", res);
      }
      const payload = (await res.json()) as { items?: Array<{ title: string; link: string; snippet?: string }> };
      return (payload.items ?? []).slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.link,
        content: r.snippet,
      }));
    },
  };
}

function createBingProvider(credential: string): SearchProvider {
  const apiKey = credential.trim();
  return {
    async search(query, maxResults) {
      const url = new URL("https://api.bing.microsoft.com/v7.0/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      const res = await fetch(url, {
        headers: { "Ocp-Apim-Subscription-Key": apiKey },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await failedSearchResponse("Bing", res);
      }
      const payload = (await res.json()) as {
        webPages?: { value?: Array<{ name: string; url: string; snippet?: string }> };
      };
      return (payload.webPages?.value ?? []).slice(0, maxResults).map((r) => ({
        title: r.name,
        url: r.url,
        content: r.snippet,
      }));
    },
  };
}

function createBraveProvider(credential: string): SearchProvider {
  const apiKey = credential.trim();
  return {
    async search(query, maxResults) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      const res = await fetch(url, {
        headers: { "X-Subscription-Token": apiKey },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await failedSearchResponse("Brave", res);
      }
      const payload = (await res.json()) as {
        web?: { results?: Array<{ title: string; url: string; description?: string }> };
      };
      return (payload.web?.results ?? []).slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.url,
        content: r.description,
      }));
    },
  };
}

function createSerperProvider(credential: string): SearchProvider {
  const apiKey = credential.trim();
  return {
    async search(query, maxResults) {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, num: maxResults }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await failedSearchResponse("Serper", res);
      }
      const payload = (await res.json()) as {
        organic?: Array<{ title: string; link: string; snippet?: string }>;
      };
      return (payload.organic ?? []).slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.link,
        content: r.snippet,
      }));
    },
  };
}

function createTavilyProvider(credential: string): SearchProvider {
  const apiKey = credential.trim();
  return {
    async search(query, maxResults) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, max_results: maxResults }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await failedSearchResponse("Tavily", res);
      }
      const payload = (await res.json()) as {
        results?: Array<{ title: string; url: string; content?: string }>;
      };
      return (payload.results ?? []).slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

type ProviderEntry = {
  create: (credential: string) => SearchProvider;
  validateCredential?: (credential: string) => void;
};

const SEARCH_PROVIDERS: Record<string, ProviderEntry> = {
  searxng: {
    create: createSearxngProvider,
    validateCredential(credential) {
      if (!URL.canParse(credential)) {
        throw new Error("WEB_SEARCH_CREDENTIAL for searxng must be a valid URL");
      }
    },
  },
  google: {
    create: createGoogleProvider,
    validateCredential(credential) {
      const idx = credential.indexOf(":");
      if (idx < 1 || idx === credential.length - 1) {
        throw new Error("WEB_SEARCH_CREDENTIAL for google must be in apikey:cx format");
      }
    },
  },
  bing: { create: createBingProvider },
  brave: { create: createBraveProvider },
  serper: { create: createSerperProvider },
  tavily: { create: createTavilyProvider },
};

export const WEB_SEARCH_PROVIDER_NAMES = Object.keys(SEARCH_PROVIDERS) as [string, ...string[]];
export type WebSearchProviderName = keyof typeof SEARCH_PROVIDERS;

// ---------------------------------------------------------------------------
// Config resolution and validation
// ---------------------------------------------------------------------------

export function resolveSearchConfig(env: {
  WEB_SEARCH_PROVIDER?: string;
  WEB_SEARCH_CREDENTIAL?: string;
  WEB_SEARCH_ENGINE_URL?: string;
}): { provider: string; credential: string } | null {
  if (env.WEB_SEARCH_PROVIDER) {
    if (!env.WEB_SEARCH_CREDENTIAL) {
      throw new Error("WEB_SEARCH_CREDENTIAL must be set when WEB_SEARCH_PROVIDER is set");
    }
    return {
      provider: env.WEB_SEARCH_PROVIDER,
      credential: env.WEB_SEARCH_CREDENTIAL,
    };
  }
  if (env.WEB_SEARCH_ENGINE_URL) {
    return { provider: "searxng", credential: env.WEB_SEARCH_ENGINE_URL };
  }
  return null;
}

export function validateSearchCredential(provider: string, credential: string): void {
  const entry = SEARCH_PROVIDERS[provider];
  if (!entry) {
    throw new Error(`Unknown search provider: ${provider}`);
  }
  if (entry.validateCredential) {
    entry.validateCredential(credential);
  } else if (!credential.trim()) {
    throw new Error(`WEB_SEARCH_CREDENTIAL for ${provider} must be a non-empty API key`);
  }
}

export function createSearchProvider(name: string, credential: string): SearchProvider {
  const entry = SEARCH_PROVIDERS[name];
  if (!entry) {
    throw new Error(`Unknown search provider: ${name}`);
  }
  return entry.create(credential);
}

export function getSearchProvider(env: {
  WEB_SEARCH_PROVIDER?: string;
  WEB_SEARCH_CREDENTIAL?: string;
  WEB_SEARCH_ENGINE_URL?: string;
}): SearchProvider | null {
  const config = resolveSearchConfig(env);
  if (!config) {
    return null;
  }
  validateSearchCredential(config.provider, config.credential);
  return createSearchProvider(config.provider, config.credential);
}
