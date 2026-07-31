/**
 * Server-side model catalog module. Loads YAML files from a directory,
 * recursively resolves remote includes (with cycle detection), and maintains
 * an in-memory index for the API endpoints.
 */
import { type Model, type ModelWithSpecifier, ModelFileDefinitionSchema } from "./definitions/model-definition";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "catalog" });

// ── State ──────────────────────────────────────────────────────────────

let modelData = new Map<string, ModelWithSpecifier>();
let mergedData: { models: Record<string, Model> } = { models: {} };
let serializedCatalog: SerializedCatalog = serializeCatalog(mergedData);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

let configuredMaxDepth: number;
let configuredDirPath: string | undefined;

let lastRefreshAt: Date | null = null;
let lastRefreshError: string | null = null;

/** Without this an unresponsive include host stalls every later refresh behind it. */
const INCLUDE_FETCH_TIMEOUT_MS = 10_000;

// ── Init ───────────────────────────────────────────────────────────────

export function configure(maxIncludeDepth = 10, modelDirPath?: string) {
  configuredMaxDepth = maxIncludeDepth;
  configuredDirPath = modelDirPath;
}

// ── Refresh ────────────────────────────────────────────────────────────

/**
 * Loads all YAML files in the configured directory, validates them, then
 * recursively fetches and merges all remote include URLs. Rebuilds all
 * indexes atomically.
 */
type CatalogIndexState = {
  models: Map<string, ModelWithSpecifier>;
  merged: Record<string, Model>;
  localSpecifiers: Set<string>;
};

export async function refresh(): Promise<void> {
  const state: CatalogIndexState = {
    models: new Map<string, ModelWithSpecifier>(),
    merged: {},
    localSpecifiers: new Set<string>(),
  };
  const visited = new Set<string>();

  try {
    if (configuredDirPath) {
      await loadDirectoryFiles(configuredDirPath, visited, state);
    }

    // Atomic swap
    modelData = state.models;
    mergedData = { models: state.merged };
    serializedCatalog = serializeCatalog(mergedData);
    lastRefreshAt = new Date();
    lastRefreshError = null;
  } catch (err) {
    lastRefreshError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

async function resolveIncludes(
  url: string,
  visited: Set<string>,
  depth: number,
  state: CatalogIndexState,
): Promise<void> {
  if (depth >= configuredMaxDepth) {
    log.warn({ url, maxDepth: configuredMaxDepth }, "Max include depth reached, skipping");
    return;
  }

  const normalized = url.toString();
  if (visited.has(normalized)) {
    log.warn({ url }, "Cycle detected, skipping already-visited include");
    return;
  }
  visited.add(normalized);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(INCLUDE_FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      log.warn({ url, status: response.status }, "Include fetch failed");
      return;
    }

    const text = await response.text();
    const result = parseModelFileYaml(text);
    if (!result.success) {
      log.warn({ url, issues: result.error.issues }, "Include validation failed");
      return;
    }

    indexModels(result.data.models, url, false, state);

    for (const nestedUrl of result.data.includes ?? []) {
      await resolveIncludes(nestedUrl, visited, depth + 1, state);
    }
  } catch (err) {
    log.warn({ url, err }, "Include fetch error");
  }
}

async function loadDirectoryFiles(
  dirPath: string,
  visited: Set<string>,
  state: CatalogIndexState,
): Promise<void> {
  let entries: string[];
  try {
    entries = (await readdir(dirPath))
      .filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
      .sort();
  } catch (err) {
    log.warn({ dirPath, err }, "Could not read model info directory, skipping");
    return;
  }

  if (entries.length === 0) {
    log.debug({ dirPath }, "Model info directory is empty");
    return;
  }

  for (const filename of entries) {
    const filePath = join(dirPath, filename);
    try {
      const yamlText = await Bun.file(filePath).text();
      const result = parseModelFileYaml(yamlText);
      if (!result.success) {
        log.warn({ filePath, issues: result.error.issues }, "Model file validation failed, skipping");
        continue;
      }

      log.debug({ filePath, modelCount: Object.keys(result.data.models).length }, "Loaded model file from directory");
      indexModels(result.data.models, filePath, true, state);

      for (const includeUrl of result.data.includes ?? []) {
        await resolveIncludes(includeUrl, visited, 0, state);
      }
    } catch (err) {
      log.warn({ filePath, err }, "Failed to load model file from directory, skipping");
    }
  }
}

function parseModelFileYaml(text: string) {
  return ModelFileDefinitionSchema.safeParse(Bun.YAML.parse(text));
}

function indexModels(
  source: Record<string, Model>,
  sourceLabel: string,
  isLocal: boolean,
  state: CatalogIndexState,
): void {
  for (const [specifier, model] of Object.entries(source)) {
    const existing = state.models.get(specifier);
    if (existing) {
      if (state.localSpecifiers.has(specifier) && !isLocal) {
        log.debug({ specifier, source: sourceLabel }, "Remote model skipped: local entry takes precedence");
        continue;
      }
      log.warn({ specifier, existingSource: existing._source, newSource: sourceLabel }, "Duplicate model specifier, overwriting");
    }

    const entry: ModelWithSpecifier = { publicSpecifier: specifier, _source: sourceLabel, ...model };
    if (model.maxContextLength === undefined) {
      log.warn({ model: specifier, source: sourceLabel }, "Model missing maxContextLength, defaulting to 131072");
    }
    state.models.set(specifier, entry);
    state.merged[specifier] = model;

    if (isLocal) state.localSpecifiers.add(specifier);
  }
}

// ── Query ──────────────────────────────────────────────────────────────

export function get(specifier: string): ModelWithSpecifier | undefined {
  return modelData.get(specifier);
}

export function resolveBatch(specifiers: string[]): Record<string, ModelWithSpecifier | null> {
  return Object.fromEntries(specifiers.map((spec) => [spec, get(spec) ?? null]));
}

export function getAll(): ModelWithSpecifier[] {
  return Array.from(modelData.values());
}

export function getByFamily(family: string): ModelWithSpecifier[] {
  return getAll().filter(m => (m.family ?? "unknown") === family);
}

/** Returns the merged model data for the /models/v1 endpoints. */
export function getMergedData(): { models: Record<string, Model> } {
  return mergedData;
}

// ── Serialized bodies ──────────────────────────────────────────────────

export interface SerializedCatalog {
  json: string;
  yaml: string;
  /** Content hash, usable as an ETag and as a change signal for clients. */
  digest: string;
}

/**
 * Specifiers are sorted before serializing so the digest tracks content only.
 * Merge order follows load order (directory files sorted, then includes in fetch
 * order), so an include that reorders its own keys would otherwise produce a new
 * digest for byte-identical data.
 */
function serializeCatalog(merged: { models: Record<string, Model> }): SerializedCatalog {
  const sorted: Record<string, Model> = {};
  for (const specifier of Object.keys(merged.models).sort()) {
    sorted[specifier] = merged.models[specifier]!;
  }

  const payload = { models: sorted };
  const json = JSON.stringify(payload);
  return {
    json,
    yaml: Bun.YAML.stringify(payload),
    digest: new Bun.CryptoHasher("sha256").update(json).digest("hex"),
  };
}

/** Bodies are built once per refresh; serving them must not re-serialize. */
export function getSerializedCatalog(): SerializedCatalog {
  return serializedCatalog;
}

// ── Auto-refresh ───────────────────────────────────────────────────────

export function startAutoRefresh(intervalMs: number): void {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    refresh().catch(err => log.error({ err }, "Auto-refresh failed"));
  }, intervalMs);
}

export function stopAutoRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function getCatalogHealth() {
  return {
    modelCount: modelData.size,
    lastRefreshAt: lastRefreshAt?.toISOString() ?? null,
    lastRefreshError,
  };
}
