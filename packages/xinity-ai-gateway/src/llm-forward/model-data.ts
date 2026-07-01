import { calcCanaryProgress, sql, modelDeploymentT, aiNodeT, modelInstallationT, modelInstallationStateT, installationMatchesLookup } from "common-db";
import { getDB } from "../db";
import { env } from "../env";
import { createInfoserverClient, deploymentLookup, deploymentEarlyLookup, lookupKey, resolveTagsForDriver, resolveRequestParamsForDriver, type ModelLookup } from "xinity-infoserver";
import { selectHost as _selectHost, type LoadBalanceStrategy } from "./load-balancer";
import { rootLogger } from "../logger";

/** Indirection for testability. tests can swap this without mock.module. */
export const _deps = { selectHost: _selectHost };

const infoClient = createInfoserverClient({
  baseUrl: env.INFOSERVER_URL,
  cacheTtlMs: env.INFOSERVER_CACHE_TTL_MS,
  logger: rootLogger.child({ name: "infoserver-client" }),
});

export { infoClient };

async function publicModelSpecifierToModelSource(orgId: string, specifier: string) {

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

  return {
    progress: calcCanaryProgress(deployment),
    primary: deploymentLookup(deployment),
    early: deploymentEarlyLookup(deployment),
  }
}

type HostLocation = {
  nodeId: string;
  driver: string;
  authToken: string | null;
  tls: boolean;
};

type ModelSources = {
  hosts: string[];
  byHost: Map<string, HostLocation>;
};

async function getModelSources(lookup: ModelLookup): Promise<ModelSources> {
  const modelLocations = await getDB().select({
    nodeId: aiNodeT.id,
    host: aiNodeT.host,
    nodePort: aiNodeT.port,
    driver: modelInstallationT.driver,
    authToken: aiNodeT.authToken,
    tls: aiNodeT.tls,
  }).from(modelInstallationT)
    .innerJoin(aiNodeT, sql`${modelInstallationT.nodeId} = ${aiNodeT.id} AND ${aiNodeT.deletedAt} IS NULL`)
    .innerJoin(modelInstallationStateT, sql`
      ${modelInstallationStateT.id} = ${modelInstallationT.id}
      AND ${modelInstallationStateT.lifecycleState} = 'ready'
    `)
    .where(sql`${installationMatchesLookup(lookupKey(lookup))} AND ${modelInstallationT.deletedAt} IS NULL`);

  const byHost = new Map<string, HostLocation>();
  for (const loc of modelLocations) {
    const key = `${loc.host}:${loc.nodePort}`;
    byHost.set(key, { nodeId: loc.nodeId, driver: loc.driver, authToken: loc.authToken, tls: loc.tls });
  }

  return { hosts: [...byHost.keys()], byHost };
}

type ModelInfo = {
  /** ai_node id serving this request. Recorded on usage events for per-node attribution. */
  nodeId: string | null;
  /** Daemon host:port to route requests through. */
  host: string;
  /** origin model name. I.e. gemma3:latest */
  model: string;
  /** Inference driver for this model installation (e.g. "ollama", "vllm"). */
  driver: string;
  /** Per-node auth token for authenticating requests to the daemon. */
  authToken: string | null;
  tls: boolean;
  /** Model type from the catalog (chat, embedding, rerank, transcription). Undefined if catalog entry is unavailable. */
  type?: string;
  /** Model tags from the catalog (e.g. "tools", "custom_code", "vision"). Undefined if catalog entry is unavailable. */
  tags?: string[];
  /** Allowed request-level passthrough params: dot-path to primitive type. Undefined if catalog entry is unavailable. */
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
  });

  if (!result) {
    return;
  }

  const resolvedLookup = result.useFinalModel
    ? accessInfo.primary
    : (accessInfo.early ?? accessInfo.primary);

  const location = finalSources.byHost.get(result.host) ?? earlySources.byHost.get(result.host);
  const driver = location?.driver ?? "ollama";
  const authToken = location?.authToken ?? null;
  const tls = location?.tls ?? false;
  const driverProvider = driver as "vllm" | "ollama";

  const model = await infoClient.fetchModel(resolvedLookup);
  const providerModel = model?.providers[driverProvider]
    ?? (resolvedLookup.kind === "legacy" ? resolvedLookup.providerModel : undefined);
  if (!providerModel) {
    result.release();
    return;
  }

  const type = model?.type;
  const tags = model ? resolveTagsForDriver(model, driverProvider) : undefined;
  const requestParams = model ? resolveRequestParamsForDriver(model, driverProvider) : undefined;

  return {
    nodeId: location?.nodeId ?? null,
    host: result.host,
    model: providerModel,
    driver,
    authToken,
    tls,
    type,
    tags,
    requestParams,
    release: result.release,
  };
}
