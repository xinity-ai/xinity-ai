/**
 * Lightweight infoserver client that fetches from the API endpoints
 * with time-limited in-memory caching. Replaces the old ModelCatalog class.
 */
import { ModelSchema, type ModelWithSpecifier } from "./definitions/model-definition";
import { resolveDriverForProviderModel, resolveTagsForDriver, resolveAllTags, resolveArgsForDriver, resolveRequestParamsForDriver, type RequestParamMap } from "./model-tags";
import { lookupKey, type ModelLookup } from "./lookup-helpers";
import { satisfiesMinVersion } from "./semver";
import { version } from "../../package.json";

export interface InfoserverClientConfig {
  /** Base URL of the infoserver (e.g. "http://localhost:8090"). */
  baseUrl: string;
  /** How long cached responses remain valid before re-fetching (ms). */
  cacheTtlMs: number;
  /** Optional logger; reports models dropped for failing content validation. */
  logger?: import("common-log").Logger;
}

function lookupCacheKey(lookup: ModelLookup): string {
  return `${lookup.kind}:${lookupKey(lookup)}`;
}

/**
 * Typed result from a single-model lookup.
 * Distinguishes between a found model, a model not available to this instance
 * (absent from the catalog, unsupported by this version, or invalid), and an
 * unreachable info server (network error / 5xx).
 * Only `found` results are cached. `not_found` is intentionally never cached so a
 * re-added or newly-supported model is picked up within the next TTL window.
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
  type?: "chat" | "embedding" | "rerank" | "transcription";
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

  /**
   * Filters models this instance cannot use. Version-gates first, so a model built
   * for a newer xinity is dropped before validation rather than rejected for shapes
   * we don't yet understand; the rest are content-validated. Failures are dropped,
   * not thrown, so one bad entry can't sink a whole listing. Fail-open: a model
   * without `entryVersion` is kept.
   */
  function gateAndValidate(raw: unknown): ModelWithSpecifier | null {
    if (raw === null || typeof raw !== "object") return null;
    const { entryVersion, maxContextLength: rawMaxContextLength } = raw as { entryVersion?: unknown; maxContextLength?: unknown };
    if (typeof entryVersion === "string" && !satisfiesMinVersion(version, entryVersion)) {
      return null;
    }
    if (rawMaxContextLength === undefined) {
      const specifier = (raw as { name?: string }).name ?? JSON.stringify(raw);
      config.logger?.warn({ model: specifier }, "Model missing maxContextLength, defaulting to 131072");
    }
    const parsed = ModelSchema.safeParse(raw);
    if (!parsed.success) {
      config.logger?.warn({ issues: parsed.error.issues }, "Dropping model that failed content validation");
      return null;
    }
    return parsed.data as ModelWithSpecifier;
  }

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
      const model = gateAndValidate(await res.json());
      if (!model) return { status: "not_found" };
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
      const models = await fetchJsonOrThrow<unknown[]>(`/api/v1/models/family/${encodeURIComponent(family)}`);
      return models.map(gateAndValidate).filter((m): m is ModelWithSpecifier => m !== null);
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
      const res = await fetchJsonOrThrow<PaginatedModels>(`/api/v1/models?${qs}`);
      const models = res.models.map(gateAndValidate).filter((m): m is ModelWithSpecifier => m !== null);
      return { ...res, models };
    });
  }

  async function fetchModelsBatch(specifiers: string[]): Promise<Record<string, ModelWithSpecifier | null>> {
    const key = `batch:${specifiers.slice().sort().join(",")}`;
    return cachedFetch(key, async () => {
      const raw = await fetchJsonOrThrow<Record<string, unknown>>(`/api/v1/models/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specifiers }),
      });
      const resolved: Record<string, ModelWithSpecifier | null> = {};
      for (const [specifier, model] of Object.entries(raw)) {
        resolved[specifier] = gateAndValidate(model);
      }
      return resolved;
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
    const tags = d ? resolveTagsForDriver(model, d) : resolveAllTags(model);
    return { type: model.type, tags };
  }

  async function hasTag(lookup: ModelLookup, tag: string, driver?: "vllm" | "ollama"): Promise<boolean> {
    const { tags } = await resolveModelMeta(lookup, driver);
    return tags.includes(tag);
  }

  async function withResolvedDriver<T>(
    lookup: ModelLookup,
    driver: "vllm" | "ollama" | undefined,
    empty: T,
    pick: (model: ModelWithSpecifier, driver: "vllm" | "ollama") => T,
  ): Promise<T> {
    const model = await fetchModel(lookup);
    if (!model) return empty;
    const resolved = driverFor(model, lookup, driver);
    if (!resolved) return empty;
    return pick(model, resolved);
  }

  async function resolveDriverArgs(lookup: ModelLookup, driver?: "vllm" | "ollama"): Promise<string[]> {
    return withResolvedDriver(lookup, driver, [], resolveArgsForDriver);
  }

  async function resolveRequestParams(lookup: ModelLookup, driver?: "vllm" | "ollama"): Promise<RequestParamMap> {
    return withResolvedDriver(lookup, driver, {}, resolveRequestParamsForDriver);
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
