import { calcCanaryProgress, sql, modelDeploymentT, aiNodeT, modelInstallationT, installationMatchesLookup } from "common-db";
import { getDB } from "../db";
import { env } from "../env";
import { createInfoserverClient, resolveTagsForDriver, resolveRequestParamsForDriver } from "xinity-infoserver";
import { selectHost as _selectHost, type LoadBalanceStrategy } from "./load-balancer";

/** Indirection for testability. tests can swap this without mock.module. */
export const _deps = { selectHost: _selectHost };

const infoClient = createInfoserverClient({ baseUrl: env.INFOSERVER_URL, cacheTtlMs: env.INFOSERVER_CACHE_TTL_MS });

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
    primary: deployment.specifier,
    early: deployment.earlySpecifier,
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

async function getModelSources(specifier: string): Promise<ModelSources> {
  const modelLocations = await getDB().select({
    nodeId: aiNodeT.id,
    host: aiNodeT.host,
    nodePort: aiNodeT.port,
    driver: modelInstallationT.driver,
    authToken: aiNodeT.authToken,
    tls: aiNodeT.tls,
  }).from(modelInstallationT)
    .innerJoin(aiNodeT, sql`${modelInstallationT.nodeId} = ${aiNodeT.id} AND ${aiNodeT.deletedAt} IS NULL`)
    .where(sql`${installationMatchesLookup(specifier)} AND ${modelInstallationT.deletedAt} IS NULL`);

  const byHost = new Map<string, HostLocation>();
  for (const loc of modelLocations) {
    const key = `${loc.host}:${loc.nodePort}`;
    byHost.set(key, { nodeId: loc.nodeId, driver: loc.driver, authToken: loc.authToken, tls: loc.tls });
  }

  return { hosts: [...byHost.keys()], byHost };
}

type ModelInfo = {
  /** ai_node id serving this request. Recorded on usage events for fleet attribution. */
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
  /** Model type from the catalog (chat, embedding, rerank). Undefined if catalog entry is unavailable. */
  type?: string;
  /** Model tags from the catalog (e.g. "tools", "custom_code", "vision"). Undefined if catalog entry is unavailable. */
  tags?: string[];
  /** Allowed request-level passthrough params: dot-path to primitive type. Undefined if catalog entry is unavailable. */
  requestParams?: Record<string, string>;
  /** Call when the request completes to release load-balancer resources. */
  release: () => void;
}

export async function getModelInfo(orgId: string, publicSpecifier: string, keyId: string): Promise<ModelInfo | undefined> {
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
    keyId,
    publicModel: publicSpecifier,
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

  const model = await infoClient.fetchModel(resolvedSpecifier);
  const providerModel = model?.providers[driverProvider];
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
    specifier: resolvedSpecifier,
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
