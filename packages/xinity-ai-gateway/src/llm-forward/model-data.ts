import { calcCanaryProgress, sql, modelDeploymentT, aiNodeT, modelInstallationT, installationMatchesLookup } from "common-db";
import { getDB } from "../db";
import { env } from "../env";
import { createInfoserverClient, deploymentLookup, deploymentEarlyLookup, lookupKey, type ModelLookup } from "xinity-infoserver";
import { selectHost as _selectHost, type LoadBalanceStrategy } from "./load-balancer";

/** Indirection for testability. tests can swap this without mock.module. */
export const _deps = { selectHost: _selectHost };

const infoClient = createInfoserverClient({ baseUrl: env.INFOSERVER_URL, cacheTtlMs: env.INFOSERVER_CACHE_TTL_MS });

/** Retrieves the mapping from public model string to internal split model representation */
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

/** Retrieves the servers under which the model identified by the given lookup is available. */
async function getModelSources(lookup: ModelLookup) {
  const modelLocations = await getDB().select({
    host: aiNodeT.host,
    nodePort: aiNodeT.port,
    driver: modelInstallationT.driver,
    authToken: aiNodeT.authToken,
    tls: aiNodeT.tls,
  }).from(modelInstallationT)
    .innerJoin(aiNodeT, sql`${modelInstallationT.nodeId} = ${aiNodeT.id} AND ${aiNodeT.deletedAt} IS NULL`)
    .where(sql`${installationMatchesLookup(lookupKey(lookup))} AND ${modelInstallationT.deletedAt} IS NULL`);

  const driverMap = new Map<string, string>();
  const authTokenMap = new Map<string, string | null>();
  const tlsMap = new Map<string, boolean>();
  const hosts: string[] = [];
  for (const loc of modelLocations) {
    const key = `${loc.host}:${loc.nodePort}`;
    driverMap.set(key, loc.driver);
    authTokenMap.set(key, loc.authToken);
    tlsMap.set(key, loc.tls);
    hosts.push(key);
  }

  return { hosts: Array.from(new Set(hosts)), driverMap, authTokenMap, tlsMap };
}

type ModelInfo = {
  /** Daemon host:port to route requests through. */
  host: string;
  /** origin model name. I.e. gemma3:latest */
  model: string;
  /** Inference driver for this model installation (e.g. "ollama", "vllm"). */
  driver: string;
  /** Per-node auth token for authenticating requests to the daemon. */
  authToken: string | null;
  /** Whether this daemon node serves over TLS. */
  tls: boolean;
  /** Model type from the catalog (chat, embedding, rerank). Undefined if catalog is unavailable. */
  type?: string;
  /** Model tags from the catalog (e.g. "tools", "custom_code", "vision"). */
  tags: string[];
  /** Allowed request-level passthrough params: dot-path to primitive type. */
  requestParams: Record<string, string>;
  /** Call when the request completes to release load-balancer resources. */
  release: () => void;
}

/** Retrieves the up to date model data for the specified api user id, and public deployment specifier.
 * If no deployment can be found, returns undefined.
 */
export async function getModelInfo(orgId: string, publicSpecifier: string, keyId: string): Promise<ModelInfo | undefined> {
  const accessInfo = await publicModelSpecifierToModelSource(orgId, publicSpecifier);
  if (!accessInfo) {
    return;
  }
  const emptySources = {
    hosts: [] as string[],
    driverMap: new Map<string, string>(),
    authTokenMap: new Map<string, string | null>(),
    tlsMap: new Map<string, boolean>(),
  };
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

  const resolvedLookup = result.useFinalModel
    ? accessInfo.primary
    : (accessInfo.early ?? accessInfo.primary);

  // Look up driver and auth token from whichever source set the host came from
  const driver = finalSources.driverMap.get(result.host)
    ?? earlySources.driverMap.get(result.host)
    ?? "ollama";
  const authToken = finalSources.authTokenMap.get(result.host)
    ?? earlySources.authTokenMap.get(result.host)
    ?? null;
  const tls = finalSources.tlsMap.get(result.host)
    ?? earlySources.tlsMap.get(result.host)
    ?? false;

  const model = await infoClient.fetchModel(resolvedLookup);
  const providerModel = model?.providers[driver as "vllm" | "ollama"]
    ?? (resolvedLookup.kind === "legacy" ? resolvedLookup.providerModel : undefined);
  if (!providerModel) {
    result.release();
    return;
  }

  const [{ type, tags }, requestParams] = await Promise.all([
    infoClient.resolveModelMeta(resolvedLookup, driver as "vllm" | "ollama"),
    infoClient.resolveRequestParams(resolvedLookup, driver as "vllm" | "ollama"),
  ]);

  return {
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
