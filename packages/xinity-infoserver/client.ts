import {
  LegacyModelSchema,
  ModelSchema,
  type LegacyModelWithSpecifier,
  type ModelWithSpecifier,
} from "./definitions/model-definition";
import { resolveTagsForDriver, resolveAllTags, resolveArgsForDriver, resolveRequestParamsForDriver, type RequestParamMap } from "./model-tags";
import { satisfiesMinVersion } from "./semver";
import { version } from "../../package.json";

export interface CatalogClientConfig {
  /** Base URL of the infoserver (e.g. "http://localhost:8090"). */
  baseUrl: string;
  /** How long the snapshot is trusted before a conditional re-fetch (ms). */
  cacheTtlMs: number;
  logger?: import("common-log").Logger;
}

export type ModelLookup =
  | { status: "found"; model: ModelWithSpecifier }
  | { status: "not_found" }
  | { status: "unavailable"; error: string };

/**
 * Holds the whole catalog and answers from it. One conditional GET per TTL, so a
 * 304 costs nothing and every lookup in a window sees the same generation of the
 * data, which per-specifier caching could not guarantee.
 */
export function createCatalogClient(config: CatalogClientConfig) {
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  let models = new Map<string, ModelWithSpecifier>();
  let digest: string | null = null;
  let etag: string | undefined;
  let loadedAt = 0;
  let inFlight: Promise<string | null> | null = null;

  /**
   * Drops entries this instance cannot use, so one bad or too-new entry does not
   * sink the snapshot. Fail-open on a missing `entryVersion`.
   */
  function index(raw: unknown): Map<string, ModelWithSpecifier> {
    const next = new Map<string, ModelWithSpecifier>();
    const source = (raw as { models?: Record<string, unknown> } | null)?.models;
    if (!source || typeof source !== "object") {
      return next;
    }

    for (const [specifier, entry] of Object.entries(source)) {
      const entryVersion = (entry as { entryVersion?: unknown } | null)?.entryVersion;
      if (typeof entryVersion === "string" && !satisfiesMinVersion(version, entryVersion)) {
        continue;
      }

      const parsed = ModelSchema.safeParse(entry);
      if (!parsed.success) {
        config.logger?.warn({ specifier, issues: parsed.error.issues }, "Dropping model that failed content validation");
        continue;
      }
      next.set(specifier, { publicSpecifier: specifier, _source: baseUrl, ...parsed.data });
    }
    return next;
  }

  /** Returns an error string when the snapshot could not be established at all. */
  async function load(): Promise<string | null> {
    try {
      const res = await fetch(`${baseUrl}/models/v2.json`, {
        headers: etag ? { "If-None-Match": etag } : {},
      });

      if (res.status === 304) {
        loadedAt = Date.now();
        return null;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const indexed = index(await res.json());
      // Swapped together, so a reader never sees half of two generations.
      models = indexed;
      etag = res.headers.get("etag") ?? undefined;
      digest = etag?.replace(/"/g, "") ?? null;
      loadedAt = Date.now();
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A reachable-once catalog keeps serving its last good generation rather than
      // going blank because one refresh failed.
      if (models.size > 0) {
        config.logger?.warn({ err: message }, "Catalog refresh failed, keeping the last snapshot");
        return null;
      }
      return message;
    }
  }

  /** Concurrent callers share one refresh instead of stampeding the server. */
  async function ensureLoaded(): Promise<string | null> {
    if (models.size > 0 && Date.now() - loadedAt < config.cacheTtlMs) {
      return null;
    }
    inFlight ??= load().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function lookup(specifier: string): Promise<ModelLookup> {
    const error = await ensureLoaded();
    if (error !== null) {
      return { status: "unavailable", error };
    }
    const model = models.get(specifier);
    return model ? { status: "found", model } : { status: "not_found" };
  }

  return {
    lookup,

    async get(specifier: string): Promise<ModelWithSpecifier | undefined> {
      const result = await lookup(specifier);
      if (result.status === "unavailable") {
        throw new Error(`Infoserver unavailable for "${specifier}": ${result.error}`);
      }
      return result.status === "found" ? result.model : undefined;
    },

    async getAll(): Promise<ModelWithSpecifier[]> {
      const error = await ensureLoaded();
      if (error !== null) {
        throw new Error(`Infoserver unavailable: ${error}`);
      }
      return Array.from(models.values());
    },

    async resolveBatch(specifiers: string[]): Promise<Record<string, ModelWithSpecifier | null>> {
      const error = await ensureLoaded();
      if (error !== null) {
        throw new Error(`Infoserver unavailable: ${error}`);
      }
      return Object.fromEntries(specifiers.map(s => [s, models.get(s) ?? null]));
    },

    /** Generation of the data currently held, or null before the first load. */
    get digest(): string | null {
      return digest;
    },
  };
}

export type CatalogClient = ReturnType<typeof createCatalogClient>;

// ── Deprecated v1 client, removed before 1.0.0 ─────────────────────────
//
// Fetches per specifier and caches per key, so entries in one process can be of
// different ages. Superseded by createCatalogClient above.

export interface InfoserverClientConfig {
  /** Base URL of the infoserver (e.g. "http://localhost:8090"). */
  baseUrl: string;
  /** How long cached responses remain valid before re-fetching (ms). */
  cacheTtlMs: number;
  /** Optional logger; reports models dropped for failing content validation. */
  logger?: import("common-log").Logger;
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
  | { status: "found"; model: LegacyModelWithSpecifier }
  | { status: "not_found" }
  | { status: "unavailable"; error: string };

export interface PaginatedModels {
  models: LegacyModelWithSpecifier[];
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
  function gateAndValidate(raw: unknown): LegacyModelWithSpecifier | null {
    if (raw === null || typeof raw !== "object") return null;
    const { entryVersion, maxContextLength: rawMaxContextLength } = raw as { entryVersion?: unknown; maxContextLength?: unknown };
    if (typeof entryVersion === "string" && !satisfiesMinVersion(version, entryVersion)) {
      return null;
    }
    if (rawMaxContextLength === undefined) {
      const specifier = (raw as { name?: string }).name ?? JSON.stringify(raw);
      config.logger?.warn({ model: specifier }, "Model missing maxContextLength, defaulting to 131072");
    }
    const parsed = LegacyModelSchema.safeParse(raw);
    if (!parsed.success) {
      config.logger?.warn({ issues: parsed.error.issues }, "Dropping model that failed content validation");
      return null;
    }
    return parsed.data as LegacyModelWithSpecifier;
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

    const url = `${baseUrl}/api/v1/models/${encodeURIComponent(specifier)}`;
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

  async function fetchModel(specifier: string): Promise<LegacyModelWithSpecifier | undefined> {
    const result = await fetchModelStatus(specifier);
    if (result.status === "found") return result.model;
    if (result.status === "unavailable") throw new Error(`Infoserver unavailable for "${specifier}": ${result.error}`);
    return undefined;
  }

  async function fetchModelsByFamily(family: string): Promise<LegacyModelWithSpecifier[]> {
    const key = `family:${family}`;
    return cachedFetch(key, async () => {
      const models = await fetchJsonOrThrow<unknown[]>(`/api/v1/models/family/${encodeURIComponent(family)}`);
      return models.map(gateAndValidate).filter((m): m is LegacyModelWithSpecifier => m !== null);
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
      const models = res.models.map(gateAndValidate).filter((m): m is LegacyModelWithSpecifier => m !== null);
      return { ...res, models };
    });
  }

  async function fetchModelsBatch(specifiers: string[]): Promise<Record<string, LegacyModelWithSpecifier | null>> {
    const key = `batch:${specifiers.slice().sort().join(",")}`;
    return cachedFetch(key, async () => {
      const raw = await fetchJsonOrThrow<Record<string, unknown>>(`/api/v1/models/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specifiers }),
      });
      const resolved: Record<string, LegacyModelWithSpecifier | null> = {};
      for (const [specifier, model] of Object.entries(raw)) {
        resolved[specifier] = gateAndValidate(model);
      }
      return resolved;
    });
  }

  type ModelMetadata = {
    type: string | undefined;
    tags: string[];
    maxContextLength: number;
  };
  async function resolveModelMeta(specifier: string, driver?: "vllm" | "ollama"): Promise<ModelMetadata> {
    const model = await fetchModel(specifier);
    if (!model) return { type: undefined, tags: [], maxContextLength: 131072 };
    const tags = driver ? resolveTagsForDriver(model, driver) : resolveAllTags(model);
    return { type: model.type, tags, maxContextLength: model.maxContextLength ?? 131072 };
  }

  async function hasTag(specifier: string, tag: string, driver?: "vllm" | "ollama"): Promise<boolean> {
    const { tags } = await resolveModelMeta(specifier, driver);
    return tags.includes(tag);
  }

  async function withResolvedDriver<T>(
    specifier: string,
    driver: "vllm" | "ollama" | undefined,
    empty: T,
    pick: (model: LegacyModelWithSpecifier, driver: "vllm" | "ollama") => T,
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
