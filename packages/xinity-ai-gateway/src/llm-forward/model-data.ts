import { calcCanaryProgress, sql, modelDeploymentT, modelInstallationT, aiNodeT } from "common-db";
import { getDB } from "../db";
import { env } from "../env";
import { createInfoserverClient } from "xinity-infoserver";
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
  `);
  if (!deployment) {
    return;
  }

  return {
    /**
     * Proportion of traffic that should be sent to the target model, as specified via modelSpecifier.
     * The rest goes to the early model as specified via earlyModelSpecifier
     */
    progress: calcCanaryProgress(deployment),
    earlyModelSpecifier: deployment.earlyModelSpecifier,
    modelSpecifier: deployment.modelSpecifier,
  }
}

/** Retrieves the servers under which the model going by the given specifier is available */
async function getModelSources(modelSpecifier: string) {

  const modelLocations = await getDB().select({
    host: aiNodeT.host,
    nodePort: aiNodeT.port,
    modelPort: modelInstallationT.port,
    driver: modelInstallationT.driver,
  }).from(modelInstallationT)
    .innerJoin(aiNodeT, sql`${modelInstallationT.nodeId} = ${aiNodeT.id} AND ${aiNodeT.deletedAt} IS NULL`)
    .where(sql`${modelInstallationT.model} = ${modelSpecifier} AND ${modelInstallationT.deletedAt} IS NULL`);

  const driverMap = new Map<string, string>();
  const hosts: string[] = [];
  for (const loc of modelLocations) {
    const key = `${loc.host}:${loc.modelPort}`;
    driverMap.set(key, loc.driver);
    hosts.push(key);
  }

  return { hosts: Array.from(new Set(hosts)), driverMap };
}

type ModelInfo = {
  /** host info to send completion requests to. I.e. 192.168.0.190:11434 */
  host: string;
  /** origin model name. I.e. gemma3:latest */
  model: string;
  /** Inference driver for this model installation (e.g. "ollama", "vllm"). */
  driver: string;
  /** Model type from the catalog (chat, embedding, rerank). Undefined if catalog is unavailable. */
  type?: string;
  /** Model tags from the catalog (e.g. "tools", "custom_code", "vision"). */
  tags: string[];
  /** Allowed request-level passthrough params: dot-path to primitive type. */
  requestParams: Record<string, string>;
  /** Call when the request completes to release load-balancer resources. */
  release: () => void;
}

/** Retrieves the up to date model data for the specified api user id, and model specifier.
 * If no model can be found, returns undefined
 */
export async function getModelInfo(orgId: string, modelSpecifier: string, keyId: string): Promise<ModelInfo | undefined> {
  const accessInfo = await publicModelSpecifierToModelSource(orgId, modelSpecifier);
  if (!accessInfo) {
    return;
  }
  const [finalSources, earlySources] = await Promise.all([
    getModelSources(accessInfo.modelSpecifier),
    accessInfo.earlyModelSpecifier
      ? getModelSources(accessInfo.earlyModelSpecifier)
      : Promise.resolve({ hosts: [], driverMap: new Map<string, string>() }),
  ]);

  const result = await _deps.selectHost(env.LOAD_BALANCE_STRATEGY as LoadBalanceStrategy, {
    hosts: finalSources.hosts,
    earlyHosts: earlySources.hosts,
    canaryProgress: accessInfo.progress,
    hasEarlyModel: !!accessInfo.earlyModelSpecifier,
    keyId,
    publicModel: modelSpecifier,
  });

  if (!result) {
    return;
  }

  const resolvedModel = result.useFinalModel
    ? accessInfo.modelSpecifier
    : (accessInfo.earlyModelSpecifier ?? accessInfo.modelSpecifier);

  // Look up driver from whichever source set the host came from
  const driver = finalSources.driverMap.get(result.host)
    ?? earlySources.driverMap.get(result.host)
    ?? "ollama";

  const [{ type, tags }, requestParams] = await Promise.all([
    infoClient.resolveModelMeta(resolvedModel),
    infoClient.resolveRequestParams(resolvedModel),
  ]);

  return {
    host: result.host,
    model: resolvedModel,
    driver,
    type,
    tags,
    requestParams,
    release: result.release,
  };
}
