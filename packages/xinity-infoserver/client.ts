/**
 * Lightweight infoserver client that fetches from the API endpoints
 * with time-limited in-memory caching. Replaces the old ModelCatalog class.
 */
import type { ModelWithSpecifier } from "./definitions/model-definition";
import { resolveDriverForProviderModel, resolveTagsForDriver, resolveArgsForDriver, resolveRequestParamsForDriver, type RequestParamMap } from "./model-tags";
import { lookupKey, type ModelLookup } from "./lookup-helpers";

export interface InfoserverClientConfig {
  /** Base URL of the infoserver (e.g. "http://localhost:8090"). */
  baseUrl: string;
  /** How long cached responses remain valid before re-fetching (ms). */
  cacheTtlMs: number;
}

function lookupCacheKey(lookup: ModelLookup): string {
  return `${lookup.kind}:${lookupKey(lookup)}`;
}

/**
 * Typed result from a single-model lookup.
 * Distinguishes between a found model, a model that genuinely does not exist in
 * the catalog (404), and an unreachable info server (network error / 5xx).
 * Only `found` results are cached. `not_found` is intentionally never cached
 * so a re-added model is picked up within the next TTL window.
 */
export type FetchModelStatus =
  | { status: "found"; model: ModelWithSpecifier }
  | { status: "not_found" }
  | { status: "unavailable"; error: string };

export interface PaginatedModels {
  models: ModelWithSpecifier[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FetchModelsParams {
  page?: number;
  pageSize?: number;
  type?: "chat" | "embedding" | "rerank";
  family?: string;
  tags?: string[];
}

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

export function createInfoserverClient(config: InfoserverClientConfig) {
  const cache = new Map<string, CacheEntry<any>>();
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  function isFresh(entry: CacheEntry<any> | undefined): entry is CacheEntry<any> {
    return entry !== undefined && Date.now() - entry.fetchedAt < config.cacheTtlMs;
  }

  async function cachedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = cache.get(key);
    if (isFresh(existing)) return existing.data;

    const data = await fetcher();
    cache.set(key, { data, fetchedAt: Date.now() });
    return data;
  }

  /**
   * Fetches a model via the requested resolution path and returns a typed status result.
   * - `found`: model exists; result is cached for `cacheTtlMs`
   * - `not_found`: server returned 404; result is NOT cached so a re-added model
   *   is visible on the next request without waiting for TTL expiry
   * - `unavailable`: network error or non-404 HTTP error; result is NOT cached
   *
   * Canonical and legacy lookups are cached under separate keys; results never cross over.
   */
  async function fetchModelStatus(lookup: ModelLookup): Promise<FetchModelStatus> {
    const key = `model:${lookupCacheKey(lookup)}`;
    const existing = cache.get(key);
    if (isFresh(existing)) return { status: "found", model: existing.data };

    const url = `${baseUrl}/api/v1/models/${encodeURIComponent(lookupKey(lookup))}?lookup=${lookup.kind === "canonical" ? "canonical" : "provider"}`;
    try {
      const res = await fetch(url);
      if (res.status === 404) return { status: "not_found" };
      if (!res.ok) return { status: "unavailable", error: `HTTP ${res.status}` };
      const model = await res.json() as ModelWithSpecifier;
      cache.set(key, { data: model, fetchedAt: Date.now() });
      return { status: "found", model };
    } catch (err) {
      return { status: "unavailable", error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function fetchModel(lookup: ModelLookup): Promise<ModelWithSpecifier | undefined> {
    const result = await fetchModelStatus(lookup);
    if (result.status === "found") return result.model;
    if (result.status === "unavailable") throw new Error(`Infoserver unavailable for ${lookup.kind} "${lookupKey(lookup)}": ${result.error}`);
    return undefined;
  }

  async function fetchModelsByFamily(family: string): Promise<ModelWithSpecifier[]> {
    const key = `family:${family}`;
    return cachedFetch(key, async () => {
      const res = await fetch(`${baseUrl}/api/v1/models/family/${encodeURIComponent(family)}`);
      if (!res.ok) throw new Error(`Infoserver error: ${res.status}`);
      return res.json() as Promise<ModelWithSpecifier[]>;
    });
  }

  async function fetchModels(params?: FetchModelsParams): Promise<PaginatedModels> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
    if (params?.type) qs.set("type", params.type);
    if (params?.family) qs.set("family", params.family);
    if (params?.tags) {
      for (const t of params.tags) qs.append("tag", t);
    }

    const key = `list:${qs.toString()}`;
    return cachedFetch(key, async () => {
      const res = await fetch(`${baseUrl}/api/v1/models?${qs}`);
      if (!res.ok) throw new Error(`Infoserver error: ${res.status}`);
      return res.json() as Promise<PaginatedModels>;
    });
  }

  async function fetchModelsBatch(specifiers: string[]): Promise<Record<string, ModelWithSpecifier | null>> {
    const key = `batch:${specifiers.slice().sort().join(",")}`;
    return cachedFetch(key, async () => {
      const res = await fetch(`${baseUrl}/api/v1/models/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specifiers }),
      });
      if (!res.ok) throw new Error(`Infoserver error: ${res.status}`);
      return res.json() as Promise<Record<string, ModelWithSpecifier | null>>;
    });
  }

  // Convenience methods that combine a fetch with pure tag helpers.
  // The driver-tag/args/params helpers need a Provider; for canonical lookups the caller passes
  // the chosen driver, for legacy lookups it's reverse-derived from the provider string.

  function driverFor(model: ModelWithSpecifier, lookup: ModelLookup, override?: "vllm" | "ollama") {
    if (override) return override;
    if (lookup.kind === "legacy") return resolveDriverForProviderModel(model, lookup.providerModel);
    return undefined;
  }

  async function resolveModelMeta(lookup: ModelLookup, driver?: "vllm" | "ollama"): Promise<{ type: string | undefined; tags: string[] }> {
    const model = await fetchModel(lookup);
    if (!model) return { type: undefined, tags: [] };
    const d = driverFor(model, lookup, driver);
    const tags = d ? resolveTagsForDriver(model, d) : (model.tags ?? []);
    return { type: model.type, tags };
  }

  async function hasTag(lookup: ModelLookup, tag: string, driver?: "vllm" | "ollama"): Promise<boolean> {
    const { tags } = await resolveModelMeta(lookup, driver);
    return tags.includes(tag);
  }

  async function resolveDriverArgs(lookup: ModelLookup, driver?: "vllm" | "ollama"): Promise<string[]> {
    const model = await fetchModel(lookup);
    if (!model) return [];
    const d = driverFor(model, lookup, driver);
    if (!d) return [];
    return resolveArgsForDriver(model, d);
  }

  async function resolveRequestParams(lookup: ModelLookup, driver?: "vllm" | "ollama"): Promise<RequestParamMap> {
    const model = await fetchModel(lookup);
    if (!model) return {};
    const d = driverFor(model, lookup, driver);
    if (!d) return {};
    return resolveRequestParamsForDriver(model, d);
  }

  return {
    fetchModel,
    fetchModelStatus,
    fetchModelsBatch,
    fetchModelsByFamily,
    fetchModels,
    resolveModelMeta,
    resolveDriverArgs,
    resolveRequestParams,
    hasTag,
  };
}

export type InfoserverClient = ReturnType<typeof createInfoserverClient>;
