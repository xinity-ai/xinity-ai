import { createCatalogClient, createInfoserverClient, resolveArgsForDriver, resolveTagsForDriver } from "xinity-infoserver";
import { env } from "../../env";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "model-catalog" });

let _catalogClient: ReturnType<typeof createCatalogClient> | null = null;
let _legacyClient: ReturnType<typeof createInfoserverClient> | null = null;

/** One client per process, so every installation resolves against one generation of the catalog. */
function getCatalogClient() {
  _catalogClient ??= createCatalogClient({
    baseUrl: env.INFOSERVER_URL,
    cacheTtlMs: env.INFOSERVER_CACHE_TTL_MS,
    logger: log,
  });
  return _catalogClient;
}

function getLegacyClient() {
  _legacyClient ??= createInfoserverClient({
    baseUrl: env.INFOSERVER_URL,
    cacheTtlMs: env.INFOSERVER_CACHE_TTL_MS,
    logger: log,
  });
  return _legacyClient;
}

export type InstallationEntry = {
  /** Name the engine itself knows the model by: a HuggingFace id for vLLM, a tag for Ollama. */
  engineSpecifier: string;
  type: string | undefined;
  tags: string[];
  args: string[];
  downloadFilter: string[];
};

/**
 * Resolves an installation for the engine it runs on. Undefined when no catalog knows
 * the specifier, or knows it only for another engine, which callers treat as
 * "cannot act on this installation" rather than as a failure.
 */
export async function resolveInstallationEntry(
  specifier: string,
  engine: "vllm" | "ollama",
): Promise<InstallationEntry | undefined> {
  const result = await getCatalogClient().lookup(specifier);
  if (result.status === "unavailable") {
    throw new Error(`Model data unavailable for "${specifier}": ${result.error}`);
  }

  if (result.status === "found") {
    const model = result.model;
    if (model.engine !== engine) {
      log.warn({ specifier, engine, entryEngine: model.engine }, "Catalog entry is for a different engine");
      return undefined;
    }
    return {
      engineSpecifier: model.engineSpecifier,
      type: model.type,
      tags: model.tags,
      args: model.engineArgs ?? [],
      downloadFilter: model.downloadFilter ?? [],
    };
  }

  return legacyEntry(specifier, engine);
}

/**
 * Installations created before the per-engine format hold a specifier the current
 * catalog does not know. Removed before 1.0.0.
 */
async function legacyEntry(specifier: string, engine: "vllm" | "ollama"): Promise<InstallationEntry | undefined> {
  const model = await getLegacyClient().fetchModel(specifier);
  const engineSpecifier = model?.providers[engine];
  if (!model || !engineSpecifier) {
    return undefined;
  }
  return {
    engineSpecifier,
    type: model.type,
    tags: resolveTagsForDriver(model, engine),
    args: resolveArgsForDriver(model, engine),
    downloadFilter: model.downloadFilter ?? [],
  };
}
