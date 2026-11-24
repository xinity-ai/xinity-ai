import { sql, inArray, aiNodeT, modelInstallationT, modelInstallationStateT, installationMatchesLookup, installationTakesRequests, installationOnLiveNode, stateOfInstallation, type lifecycleStateEnum } from "common-db";
import { getDB } from "../db";
import type { ModelLookup } from "./model-data";
import { config } from "../config";
import { createCatalogClient, createInfoserverClient, resolveTagsForDriver, resolveRequestParamsForDriver, type ModelType } from "common-env/model-catalog";
import { admit as _admit, selectHost as _selectHost, type LoadBalanceStrategy, type HostMeta, type SelectHostResult } from "./load-balancer";
import { rootLogger } from "../logger";

/** Indirection for testability. tests can swap this without mock.module. */
export const _deps = { selectHost: _selectHost, admit: _admit };

export const DEFAULT_MAX_CONTEXT_LENGTH = 131072;

let _catalogClient: ReturnType<typeof createCatalogClient> | undefined;
let _infoClient: ReturnType<typeof createInfoserverClient> | undefined;

export function getCatalogClient() {
  if (!_catalogClient) {
    _catalogClient = createCatalogClient({
      baseUrl: config.infoserver.url,
      cacheTtlMs: config.infoserver.cacheTtlMs,
      logger: rootLogger.child({ name: "catalog-client" }),
    });
  }
  return _catalogClient;
}

/** @deprecated Reaches the pre-per-engine catalog. Removed before 1.0.0. */
export function getInfoClient() {
  if (!_infoClient) {
    _infoClient = createInfoserverClient({
      baseUrl: config.infoserver.url,
      cacheTtlMs: config.infoserver.cacheTtlMs,
      logger: rootLogger.child({ name: "infoserver-client" }),
    });
  }
  return _infoClient;
}

/** The deployment row an installation serves, named by the installation's column pointing at it. */
export type InstallationOwner = { column: "legacyId" | "managedId"; id: string };

const modelSourcesCache = new Map<string, { data: ModelSources; expiresAt: number }>();

/**
 * Bumped on every invalidation so a query that was already in flight cannot write
 * its now-stale result into the cache it raced.
 */
let sourcesGeneration = 0;

export function invalidateModelSources(): void {
  sourcesGeneration += 1;
  modelSourcesCache.clear();
}

type HostLocation = {
  installationId: string;
  nodeId: string;
  machineName: string | null;
  driver: string;
  authToken: string | null;
  tls: boolean;
  maxNumSeqs: number | null;
};

export type ModelSources = {
  hosts: string[];
  byHost: Map<string, HostLocation>;
};

export async function getModelSources(owner: InstallationOwner, specifier: string): Promise<ModelSources> {
  const cacheKey = `${owner.column}:${owner.id}:${specifier}`;
  const now = Date.now();
  const cached = modelSourcesCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const generationAtQuery = sourcesGeneration;

  const modelLocations = await getDB().select({
    installationId: modelInstallationT.id,
    nodeId: aiNodeT.id,
    machineName: aiNodeT.machineName,
    host: aiNodeT.host,
    nodePort: aiNodeT.port,
    driver: modelInstallationT.driver,
    maxNumSeqs: modelInstallationT.maxNumSeqs,
    authToken: aiNodeT.authToken,
    tls: aiNodeT.tls,
  }).from(modelInstallationT)
    .innerJoin(aiNodeT, installationOnLiveNode)
    .innerJoin(modelInstallationStateT, sql`
      ${stateOfInstallation}
      AND ${modelInstallationStateT.lifecycleState} = 'ready'
    `)
    .where(sql`
      ${modelInstallationT[owner.column]} = ${owner.id}
    AND
      ${installationMatchesLookup(specifier)}
    AND
      ${modelInstallationT.deletedAt} IS NULL
    AND
      ${installationTakesRequests}
    `);

  const byHost = new Map<string, HostLocation>();
  for (const loc of modelLocations) {
    const key = `${loc.host}:${loc.nodePort}`;
    byHost.set(key, { installationId: loc.installationId, nodeId: loc.nodeId, machineName: loc.machineName, driver: loc.driver, authToken: loc.authToken, tls: loc.tls, maxNumSeqs: loc.maxNumSeqs });
  }

  const result: ModelSources = { hosts: [...byHost.keys()], byHost };
  if (generationAtQuery === sourcesGeneration) {
    modelSourcesCache.set(cacheKey, { data: result, expiresAt: now + config.cache.modelTtlSeconds() * 1000 });
  }

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
  type?: ModelType;
  tags?: string[];
  maxContextLength: number;
  audioPositionsPerSecond?: number;
  defaultInferenceSteps?: number;
  requestParams?: Record<string, string>;
};

async function resolveCatalogMeta(specifier: string, driver: "vllm" | "ollama"): Promise<CatalogMeta> {
  const result = await getCatalogClient().lookup(specifier);
  if (result.status === "unavailable") {
    throw new Error(`Infoserver unavailable for "${specifier}": ${result.error}`);
  }
  if (result.status === "found") {
    const { engineSpecifier, type, tags, sizing, requestParams, defaultInferenceSteps } = result.model;
    return { engineSpecifier, type, tags, maxContextLength: sizing.maxContextLength, audioPositionsPerSecond: sizing.audioPositionsPerSecond, requestParams, defaultInferenceSteps };
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

export type ServingSide = { specifier: string; sources: ModelSources };

export type HostRequest = {
  final: ServingSide;
  /** The side a legacy canary moves traffic away from. */
  early?: ServingSide;
  /** Share of requests, in percent, that go to `final` while `early` is set. */
  progress: number;
  publicSpecifier: string;
  prefixHashes?: string[];
};

/** Picks a host for the request among the sides' ready installations and admits the request there. */
export async function selectAdmittedHost({ final, early, progress, publicSpecifier, prefixHashes }: HostRequest): Promise<ModelLookup> {
  const earlySources = early?.sources ?? { hosts: [], byHost: new Map() };
  const hostMeta = buildHostMeta(final.sources, earlySources);
  const full = new Set<string>();
  let result: SelectHostResult | undefined;
  let location: HostLocation | undefined;
  for (;;) {
    result = await _deps.selectHost(config.inference.loadBalanceStrategy() as LoadBalanceStrategy, {
      hosts: final.sources.hosts.filter((host) => !full.has(host)),
      earlyHosts: earlySources.hosts.filter((host) => !full.has(host)),
      canaryProgress: progress,
      hasEarlyModel: !!early,
      publicModel: publicSpecifier,
      prefixHashes,
      hostMeta,
    });
    if (!result) {
      return { status: full.size > 0 ? "busy" : "unavailable" };
    }
    // Both sides can run on one node, so the host is looked up on the side that was picked.
    location = (result.useFinalModel ? final.sources : earlySources).byHost.get(result.host);
    if (!location) {
      result.release();
      return { status: "unavailable" };
    }
    const releaseAdmission = await _deps.admit(location.installationId, location.maxNumSeqs);
    if (releaseAdmission) {
      const releaseSelection = result.release;
      result = { ...result, release: () => { releaseSelection(); releaseAdmission(); } };
      break;
    }
    result.release();
    full.add(result.host);
  }

  const resolvedSpecifier = result.useFinalModel ? final.specifier : (early?.specifier ?? final.specifier);
  const { driver, authToken, tls } = location;
  const driverProvider = driver as "vllm" | "ollama";

  const meta = await resolveCatalogMeta(resolvedSpecifier, driverProvider).catch((err: unknown) => {
    result.release();
    throw err;
  });

  return {
    status: "found",
    info: {
      installationId: location.installationId,
      nodeId: location.nodeId,
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
      audioPositionsPerSecond: meta.audioPositionsPerSecond,
      defaultInferenceSteps: meta.defaultInferenceSteps,
      requestParams: meta.requestParams,
      release: result.release,
    },
  };
}

export type LifecycleState = typeof lifecycleStateEnum.enumValues[number];
type InstallationLifecycle = LifecycleState | null;

const LIFECYCLE_PRIORITY: Record<LifecycleState, number> = {
  ready: 4,
  installing: 3,
  downloading: 2,
  failed: 1,
};

export function deriveStatus(lifecycles: InstallationLifecycle[]): LifecycleState | null {
  if (lifecycles.length === 0) {
    return null;
  }
  const concrete: LifecycleState[] = lifecycles.map(l => l ?? "downloading");
  return concrete.reduce((best, current) => {
    return LIFECYCLE_PRIORITY[current] > LIFECYCLE_PRIORITY[best] ? current : best;
  });
}

type Placed = { group: { id: string; size: number } | null; lifecycle: InstallationLifecycle };

export function replicaLifecycles(placed: Placed[]): InstallationLifecycle[] {
  const singles = placed.filter((installation) => !installation.group).map(({ lifecycle }) => lifecycle);
  const groups = Map.groupBy(placed.filter((installation) => installation.group), (installation) => installation.group!.id);
  // A group takes requests only once every member is ready, so it lists as its least ready member.
  const grouped = [...groups.values()].map((members) => members.length < members[0]!.group!.size
    ? null
    : members.map(({ lifecycle }) => lifecycle ?? "downloading").reduce((worst, current) => (LIFECYCLE_PRIORITY[current] < LIFECYCLE_PRIORITY[worst] ? current : worst)));
  return [...singles, ...grouped];
}

/** Each owner's installations on live nodes, keyed by owner id. Owners without one are left out. */
export async function placedInstallations(column: InstallationOwner["column"], ids: string[]): Promise<Map<string, Placed[]>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await getDB()
    .select({ owner: modelInstallationT[column], group: modelInstallationT.group, lifecycle: modelInstallationStateT.lifecycleState })
    .from(modelInstallationT)
    .innerJoin(aiNodeT, installationOnLiveNode)
    .leftJoin(modelInstallationStateT, stateOfInstallation)
    .where(sql`${inArray(modelInstallationT[column], ids)} AND ${modelInstallationT.deletedAt} IS NULL`);
  return Map.groupBy(rows.map(({ owner, group, lifecycle }) => ({ owner: owner!, group, lifecycle })), ({ owner }) => owner);
}

/**
 * Specifiers left out of the result fall back to the caller's default, which is also
 * how an unreachable catalog is handled: a listing of deployments is still useful
 * without context lengths, so it degrades rather than failing.
 */
export async function resolveMaxContextLengths(specifiers: string[]): Promise<Map<string, number>> {
  const resolved = new Map<string, number>();
  const unresolved: string[] = [];
  if (specifiers.length === 0) {
    return resolved;
  }

  try {
    const fromCatalog = await getCatalogClient().resolveBatch(specifiers);
    for (const [specifier, model] of Object.entries(fromCatalog)) {
      if (model) {
        resolved.set(specifier, model.sizing.maxContextLength);
      } else {
        unresolved.push(specifier);
      }
    }
  } catch (err) {
    rootLogger.warn({ err }, "Catalog unavailable, listing models without context lengths");
    return resolved;
  }

  if (unresolved.length === 0) {
    return resolved;
  }

  // Pre-per-engine deployments. Removed before 1.0.0.
  try {
    const fromLegacy = await getInfoClient().fetchModelsBatch(unresolved);
    for (const [specifier, model] of Object.entries(fromLegacy)) {
      if (model?.maxContextLength !== undefined) {
        resolved.set(specifier, model.maxContextLength);
      }
    }
  } catch (err) {
    rootLogger.warn({ err }, "Deprecated catalog unavailable, defaulting context length");
  }
  return resolved;
}

/** A canary request can land on either model, so only the shortest context is safe to advertise. */
export function shortestContext(specifiers: string[], known: Map<string, number>): number {
  const lengths = specifiers.flatMap((specifier) => known.get(specifier) ?? []);
  return lengths.length > 0 ? Math.min(...lengths) : DEFAULT_MAX_CONTEXT_LENGTH;
}
