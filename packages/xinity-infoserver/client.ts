/**
 * Lightweight infoserver client that fetches from the API endpoints
 * with time-limited in-memory caching. Replaces the old ModelCatalog class.
 */
import type { ModelWithSpecifier } from "./definitions/model-definition";
import { resolveTagsForDriver, resolveAllTags, resolveArgsForDriver, resolveRequestParamsForDriver, type RequestParamMap } from "./model-tags";

export interface InfoserverClientConfig {
  /** Base URL of the infoserver (e.g. "http://localhost:8090"). */
  baseUrl: string;
  /** How long cached responses remain valid before re-fetching (ms). */
  cacheTtlMs: number;
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

  async function fetchJsonOrThrow<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw new Error(`Infoserver error: ${res.status}`);
    return res.json() as Promise<T>;
  }

  /**
   * Fetches a model by canonical specifier and returns a typed status result.
   * - `found`: model exists; result is cached for `cacheTtlMs`
   * - `not_found`: server returned 404; result is NOT cached so a re-added model
   *   is visible on the next request without waiting for TTL expiry
   * - `unavailable`: network error or non-404 HTTP error; result is NOT cached
   */
  async function fetchModelStatus(specifier: string): Promise<FetchModelStatus> {
    const key = `model:${specifier}`;
    const existing = cache.get(key);
    if (isFresh(existing)) return { status: "found", model: existing.data };

    const url = `${baseUrl}/api/v1/models/${encodeURIComponent(specifier)}?lookup=canonical`;
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

  async function fetchModel(specifier: string): Promise<ModelWithSpecifier | undefined> {
    const result = await fetchModelStatus(specifier);
    if (result.status === "found") return result.model;
    if (result.status === "unavailable") throw new Error(`Infoserver unavailable for "${specifier}": ${result.error}`);
    return undefined;
  }

  async function fetchModelsByFamily(family: string): Promise<ModelWithSpecifier[]> {
    const key = `family:${family}`;
    return cachedFetch(key, () =>
      fetchJsonOrThrow<ModelWithSpecifier[]>(`/api/v1/models/family/${encodeURIComponent(family)}`),
    );
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
    return cachedFetch(key, () =>
      fetchJsonOrThrow<PaginatedModels>(`/api/v1/models?${qs}`),
    );
  }

  async function fetchModelsBatch(specifiers: string[]): Promise<Record<string, ModelWithSpecifier | null>> {
    const key = `batch:${specifiers.slice().sort().join(",")}`;
    return cachedFetch(key, () =>
      fetchJsonOrThrow<Record<string, ModelWithSpecifier | null>>(`/api/v1/models/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specifiers }),
      }),
    );
  }

  async function resolveModelMeta(specifier: string, driver?: "vllm" | "ollama"): Promise<{ type: string | undefined; tags: string[] }> {
    const model = await fetchModel(specifier);
    if (!model) return { type: undefined, tags: [] };
    const tags = driver ? resolveTagsForDriver(model, driver) : resolveAllTags(model);
    return { type: model.type, tags };
  }

  async function hasTag(specifier: string, tag: string, driver?: "vllm" | "ollama"): Promise<boolean> {
    const { tags } = await resolveModelMeta(specifier, driver);
    return tags.includes(tag);
  }

  async function withResolvedDriver<T>(
    specifier: string,
    driver: "vllm" | "ollama" | undefined,
    empty: T,
    pick: (model: ModelWithSpecifier, driver: "vllm" | "ollama") => T,
  ): Promise<T> {
    const model = await fetchModel(specifier);
    if (!model || !driver) return empty;
    return pick(model, driver);
  }

  async function resolveDriverArgs(specifier: string, driver?: "vllm" | "ollama"): Promise<string[]> {
    return withResolvedDriver(specifier, driver, [], resolveArgsForDriver);
  }

  async function resolveRequestParams(specifier: string, driver?: "vllm" | "ollama"): Promise<RequestParamMap> {
    return withResolvedDriver(specifier, driver, {}, resolveRequestParamsForDriver);
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
