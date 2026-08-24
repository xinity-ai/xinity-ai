import { calcCanaryProgress, sql, modelDeploymentT, aiNodeT, modelInstallationT, modelInstallationStateT, installationMatchesLookup } from "common-db";
import { getDB } from "../db";
import { env } from "../env";
import { createCatalogClient, createInfoserverClient, resolveTagsForDriver, resolveRequestParamsForDriver } from "xinity-infoserver";
import { selectHost as _selectHost, type LoadBalanceStrategy, type HostMeta } from "./load-balancer";
import { rootLogger } from "../logger";

/** Indirection for testability. tests can swap this without mock.module. */
export const _deps = { selectHost: _selectHost };

const DEFAULT_MAX_CONTEXT_LENGTH = 131072;

let _catalogClient: ReturnType<typeof createCatalogClient> | undefined;
let _infoClient: ReturnType<typeof createInfoserverClient> | undefined;

export function getCatalogClient() {
  if (!_catalogClient) {
    _catalogClient = createCatalogClient({
      baseUrl: env.INFOSERVER_URL,
      cacheTtlMs: env.INFOSERVER_CACHE_TTL_MS,
      logger: rootLogger.child({ name: "catalog-client" }),
    });
  }
  return _catalogClient;
}

/** @deprecated Reaches the pre-per-engine catalog. Removed before 1.0.0. */
export function getInfoClient() {
  if (!_infoClient) {
    _infoClient = createInfoserverClient({
      baseUrl: env.INFOSERVER_URL,
      cacheTtlMs: env.INFOSERVER_CACHE_TTL_MS,
      logger: rootLogger.child({ name: "infoserver-client" }),
    });
  }
  return _infoClient;
}

import { redis } from "bun";

const log = rootLogger.child({ name: "model-data" });

const MODEL_CACHE_TTL_SECONDS = 10;

type CachedDeployment = {
  specifier: string;
  earlySpecifier: string | null;
  progress: number;
  canaryProgressFrom: number | null;
  canaryProgressUntil: number | null;
};

const modelSourcesCache = new Map<string, { data: ModelSources; expiresAt: number }>();

export function _clearModelSourcesCacheForTest(): void {
  modelSourcesCache.clear();
}

async function publicModelSpecifierToModelSource(orgId: string, specifier: string) {
  const cacheKey = `gateway:dep:${orgId}:${specifier}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const d = JSON.parse(cached) as CachedDeployment;
      const deploymentForCalc = {
        ...d,
        canaryProgressFrom: d.canaryProgressFrom !== null ? new Date(d.canaryProgressFrom) : null,
        canaryProgressUntil: d.canaryProgressUntil !== null ? new Date(d.canaryProgressUntil) : null,
      };
      return {
        progress: calcCanaryProgress(deploymentForCalc as any),
        primary: d.specifier,
        early: d.earlySpecifier,
      };
    }
  } catch (err) {
    log.warn({ err }, "Redis error reading deployment cache");
  }

  const [deployment] = await getDB().select().from(modelDeploymentT).where(sql`
    ${modelDeploymentT.organizationId} = ${orgId}
    AND
    ${modelDeploymentT.publicSpecifier} = ${specifier}
    AND
    ${modelDeploymentT.enabled}
    AND
    ${modelDeploymentT.deletedAt} IS NULL
  `).limit(1);

  if (!deployment) {
    return;
  }

  const cachedData: CachedDeployment = {
    specifier: deployment.specifier,
    earlySpecifier: deployment.earlySpecifier,
    progress: deployment.progress,
    canaryProgressFrom: deployment.canaryProgressFrom ? new Date(deployment.canaryProgressFrom).valueOf() : null,
    canaryProgressUntil: deployment.canaryProgressUntil ? new Date(deployment.canaryProgressUntil).valueOf() : null,
  };

  void redis.set(cacheKey, JSON.stringify(cachedData), "EX", MODEL_CACHE_TTL_SECONDS)
    .catch((err: unknown) => log.warn({ err }, "Redis error in set deployment cache"));

  return {
    progress: calcCanaryProgress(deployment),
    primary: deployment.specifier,
    early: deployment.earlySpecifier,
  };
}

type HostLocation = {
  nodeId: string;
  machineName: string | null;
  driver: string;
  authToken: string | null;
  tls: boolean;
};

type ModelSources = {
  hosts: string[];
  byHost: Map<string, HostLocation>;
};

async function getModelSources(specifier: string): Promise<ModelSources> {
  const now = Date.now();
  const cached = modelSourcesCache.get(specifier);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const modelLocations = await getDB().select({
    nodeId: aiNodeT.id,
    machineName: aiNodeT.machineName,
    host: aiNodeT.host,
    nodePort: aiNodeT.port,
    driver: modelInstallationT.driver,
    authToken: aiNodeT.authToken,
    tls: aiNodeT.tls,
  }).from(modelInstallationT)
    .innerJoin(aiNodeT, sql`${modelInstallationT.nodeId} = ${aiNodeT.id} AND ${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`)
    .innerJoin(modelInstallationStateT, sql`
      ${modelInstallationStateT.id} = ${modelInstallationT.id}
      AND ${modelInstallationStateT.lifecycleState} = 'ready'
    `)
    .where(sql`${installationMatchesLookup(specifier)} AND ${modelInstallationT.deletedAt} IS NULL`);

  const byHost = new Map<string, HostLocation>();
  for (const loc of modelLocations) {
    const key = `${loc.host}:${loc.nodePort}`;
    byHost.set(key, { nodeId: loc.nodeId, machineName: loc.machineName, driver: loc.driver, authToken: loc.authToken, tls: loc.tls });
  }

  const result: ModelSources = { hosts: [...byHost.keys()], byHost };
  modelSourcesCache.set(specifier, { data: result, expiresAt: now + MODEL_CACHE_TTL_SECONDS * 1000 });

  return result;
}

function buildHostMeta(...sources: ModelSources[]): Map<string, HostMeta> {
  const hostMeta = new Map<string, HostMeta>();
  for (const source of sources) {
    for (const [host, loc] of source.byHost) {
      hostMeta.set(host, { nodeId: loc.nodeId, machineName: loc.machineName ?? host });
    }
  }
  return hostMeta;
}

type CatalogMeta = {
  /** Name the engine itself knows the model by. Undefined when the catalog has no entry. */
  engineSpecifier?: string;
  type?: string;
  tags?: string[];
  maxContextLength: number;
  requestParams?: Record<string, string>;
};

async function resolveCatalogMeta(specifier: string, driver: "vllm" | "ollama"): Promise<CatalogMeta> {
  const result = await getCatalogClient().lookup(specifier);
  if (result.status === "unavailable") {
    throw new Error(`Infoserver unavailable for "${specifier}": ${result.error}`);
  }
  if (result.status === "found") {
    const { engineSpecifier, type, tags, sizing, requestParams } = result.model;
    return { engineSpecifier, type, tags, maxContextLength: sizing.maxContextLength, requestParams };
  }
  return legacyCatalogMeta(specifier, driver);
}

/**
 * Deployments created before the per-engine format hold a specifier the current
 * catalog does not know. Removed before 1.0.0.
 */
async function legacyCatalogMeta(specifier: string, driver: "vllm" | "ollama"): Promise<CatalogMeta> {
  const model = await getInfoClient().fetchModel(specifier);
  if (!model) {
    return { maxContextLength: DEFAULT_MAX_CONTEXT_LENGTH };
  }
  return {
    engineSpecifier: model.providers[driver],
    type: model.type,
    tags: resolveTagsForDriver(model, driver),
    maxContextLength: model.maxContextLength ?? DEFAULT_MAX_CONTEXT_LENGTH,
    requestParams: resolveRequestParamsForDriver(model, driver),
  };
}

type ModelInfo = {
  /** ai_node id serving this request. Recorded on usage events for per-node attribution. */
  nodeId: string | null;
  /** Daemon host:port to route requests through. */
  host: string;
  /** Canonical model identifier; used to route to the right daemon installation. */
  specifier: string;
  /** Driver-side provider model name (e.g. gemma3:latest); used as the OpenAI body's `model` field. */
  model: string;
  /** Inference driver for this model installation (e.g. "ollama", "vllm"). */
  driver: string;
  /** Per-node auth token for authenticating requests to the daemon. */
  authToken: string | null;
  tls: boolean;
  /** Model type from the catalog (chat, embedding, rerank, transcription). Undefined if catalog entry is unavailable. */
  type?: string;
  tags?: string[];
  maxContextLength: number;
  requestParams?: Record<string, string>;
  /** Call when the request completes to release load-balancer resources. */
  release: () => void;
}

export async function getModelInfo(orgId: string, publicSpecifier: string, prefixHashes?: string[]): Promise<ModelInfo | undefined> {
  const accessInfo = await publicModelSpecifierToModelSource(orgId, publicSpecifier);
  if (!accessInfo) {
    return;
  }
  const emptySources: ModelSources = { hosts: [], byHost: new Map() };
  const [finalSources, earlySources] = await Promise.all([
    getModelSources(accessInfo.primary),
    accessInfo.early
      ? getModelSources(accessInfo.early)
      : Promise.resolve(emptySources),
  ]);

  const result = await _deps.selectHost(env.LOAD_BALANCE_STRATEGY as LoadBalanceStrategy, {
    hosts: finalSources.hosts,
    earlyHosts: earlySources.hosts,
    canaryProgress: accessInfo.progress,
    hasEarlyModel: !!accessInfo.early,
    publicModel: publicSpecifier,
    prefixHashes,
    hostMeta: buildHostMeta(finalSources, earlySources),
  });

  if (!result) {
    return;
  }

  const resolvedSpecifier = result.useFinalModel
    ? accessInfo.primary
    : (accessInfo.early ?? accessInfo.primary);

  const location = finalSources.byHost.get(result.host) ?? earlySources.byHost.get(result.host);
  const driver = location?.driver ?? "ollama";
  const authToken = location?.authToken ?? null;
  const tls = location?.tls ?? false;
  const driverProvider = driver as "vllm" | "ollama";

  const meta = await resolveCatalogMeta(resolvedSpecifier, driverProvider);

  return {
    nodeId: location?.nodeId ?? null,
    host: result.host,
    specifier: resolvedSpecifier,
    // Best-effort pass-through: when the catalog cannot resolve the specifier,
    // forward it as the model name and let the backend reject a mismatch.
    model: meta.engineSpecifier ?? resolvedSpecifier,
    driver,
    authToken,
    tls,
    type: meta.type,
    tags: meta.tags,
    maxContextLength: meta.maxContextLength,
    requestParams: meta.requestParams,
    release: result.release,
  };
}
