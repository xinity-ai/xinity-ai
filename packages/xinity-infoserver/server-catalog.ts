/**
 * Server-side model catalog module. Reads the local YAML file, recursively
 * resolves remote includes (with cycle detection), and maintains an
 * in-memory index for the API endpoints.
 */
import { type Model, type ModelWithSpecifier, ModelFileDefinitionSchema } from "./definitions/model-definition";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "catalog" });

// ── State ──────────────────────────────────────────────────────────────

let modelData = new Map<string, ModelWithSpecifier>();
let providerModelIndex = new Map<string, string>();
let mergedData: { models: Record<string, Model> } = { models: {} };
let refreshTimer: ReturnType<typeof setInterval> | null = null;

let configuredFilePath: string | undefined;
let configuredMaxDepth: number;
let configuredDirPath: string | undefined;

let lastRefreshAt: Date | null = null;
let lastRefreshError: string | null = null;

// ── Init ───────────────────────────────────────────────────────────────

export function configure(maxIncludeDepth = 10, modelFilePath?: string, modelDirPath?: string) {
  configuredFilePath = modelFilePath;
  configuredMaxDepth = maxIncludeDepth;
  configuredDirPath = modelDirPath;
}

// ── Refresh ────────────────────────────────────────────────────────────

/**
 * Reads the local YAML file, validates it, then recursively fetches
 * and merges all remote include URLs. Rebuilds all indexes atomically.
 */
type CatalogIndexState = {
  models: Map<string, ModelWithSpecifier>;
  providerIndex: Map<string, string>;
  merged: Record<string, Model>;
  localSpecifiers: Set<string>;
};

export async function refresh(): Promise<void> {
  const state: CatalogIndexState = {
    models: new Map<string, ModelWithSpecifier>(),
    providerIndex: new Map<string, string>(),
    merged: {},
    localSpecifiers: new Set<string>(),
  };
  const visited = new Set<string>();

  try {
    if (configuredFilePath) {
      const yamlText = await Bun.file(configuredFilePath).text();
      const result = parseModelFileYaml(yamlText);
      if (!result.success) {
        throw new Error(`Model file validation failed (${configuredFilePath}): ${result.error.message}`);
      }

      indexModels(result.data.models, configuredFilePath, true, state);

      for (const includeUrl of result.data.includes ?? []) {
        await resolveIncludes(includeUrl, visited, 0, state);
      }
    }

    if (configuredDirPath) {
      await loadDirectoryFiles(configuredDirPath, visited, state);
    }

    // Atomic swap
    modelData = state.models;
    providerModelIndex = state.providerIndex;
    mergedData = { models: state.merged };
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
    const response = await fetch(url);
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

      log.info({ filePath, modelCount: Object.keys(result.data.models).length }, "Loaded model file from directory");
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

    if (isLocal) state.localSpecifiers.add(specifier);

    for (const providerModel of Object.values(model.providers)) {
      if (providerModel) {
        state.providerIndex.set(providerModel, specifier);
      }
    }
  }
}

// ── Query ──────────────────────────────────────────────────────────────

export function get(specifier: string): ModelWithSpecifier | undefined {
  return modelData.get(specifier);
}

export function getByProviderModel(providerModel: string): ModelWithSpecifier | undefined {
  const spec = providerModelIndex.get(providerModel);
  return spec ? modelData.get(spec) : undefined;
}

export function resolve(specifier: string): ModelWithSpecifier | undefined {
  return get(specifier) ?? getByProviderModel(specifier);
}

export function resolveBatch(specifiers: string[]): Record<string, ModelWithSpecifier | null> {
  return Object.fromEntries(specifiers.map((spec) => [spec, resolve(spec) ?? null]));
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
