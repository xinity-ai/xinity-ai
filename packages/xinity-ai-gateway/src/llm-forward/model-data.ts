import { sql, deploymentT } from "common-db";
import { getDB } from "../db";
import { config } from "../config";
import { cache } from "../cache";
import { rootLogger } from "../logger";
import { GATEWAY_DEPLOYMENT_TYPES, type LoadedDeployment } from "./deployment-types";

const log = rootLogger.child({ name: "model-data" });

export type ModelInfo = {
  /** ai_node id serving this request. Recorded on usage events for per-node attribution. */
  nodeId: string | null;
  /** Daemon host:port to route requests through. */
  host: string;
  installationId: string;
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
  audioPositionsPerSecond?: number;
  requestParams?: Record<string, string>;
  /** Call when the request completes to release load-balancer resources. */
  release: () => void;
}

export type ModelLookup =
  | { status: "found"; info: ModelInfo }
  | { status: "unknown" }
  | { status: "unavailable" }
  | { status: "busy" };

export type ModelLookupFailure = Exclude<ModelLookup["status"], "found">;

const DEPLOYMENT_CACHE_PREFIX = "gateway:deployment-entry:";

/** The notified deployment id cannot be mapped back to the org and specifier keying this cache. */
export async function invalidateDeployments(): Promise<void> {
  try {
    await cache.delPrefix(DEPLOYMENT_CACHE_PREFIX);
  } catch (err) {
    log.warn({ err }, "Cache error clearing deployment cache");
  }
}

async function loadDeployment(orgId: string, publicSpecifier: string): Promise<LoadedDeployment | undefined> {
  const cacheKey = `${DEPLOYMENT_CACHE_PREFIX}${orgId}:${publicSpecifier}`;
  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as LoadedDeployment;
    }
  } catch (err) {
    log.warn({ err }, "Cache error reading deployment cache");
  }

  const [entry] = await getDB().select().from(deploymentT).where(sql`
    ${deploymentT.organizationId} = ${orgId}
    AND
    ${deploymentT.publicSpecifier} = ${publicSpecifier}
    AND
    ${deploymentT.enabled}
    AND
    ${deploymentT.deletedAt} IS NULL
  `).limit(1);
  if (!entry) {
    return undefined;
  }

  const payload = await GATEWAY_DEPLOYMENT_TYPES[entry.type].load(entry);
  if (!payload) {
    return undefined;
  }
  const loaded: LoadedDeployment = { type: entry.type, payload };

  void cache.set(cacheKey, JSON.stringify(loaded), config.cache.modelTtlSeconds())
    .catch((err: unknown) => log.warn({ err }, "Cache error in set deployment cache"));

  return loaded;
}

export async function getModelInfo(orgId: string, publicSpecifier: string, prefixHashes?: string[]): Promise<ModelLookup> {
  const deployment = await loadDeployment(orgId, publicSpecifier);
  if (!deployment) {
    return { status: "unknown" };
  }
  return GATEWAY_DEPLOYMENT_TYPES[deployment.type].resolve(deployment.payload, publicSpecifier, prefixHashes);
}
