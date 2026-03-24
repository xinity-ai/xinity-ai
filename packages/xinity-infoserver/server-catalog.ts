/**
 * Server-side model catalog module. Reads the local YAML file, recursively
 * resolves remote includes (with cycle detection), and maintains an
 * in-memory index for the API endpoints.
 */
import { type Model, type ModelWithSpecifier, ModelFileDefinitionSchema } from "./definitions/model-definition";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "catalog" });

// ── State ──────────────────────────────────────────────────────────────

let modelData = new Map<string, ModelWithSpecifier>();
let providerModelIndex = new Map<string, string>();
let mergedData: { models: Record<string, Model> } = { models: {} };
let refreshTimer: ReturnType<typeof setInterval> | null = null;

let configuredFilePath: string;
let configuredMaxDepth: number;

// ── Init ───────────────────────────────────────────────────────────────

export function configure(modelFilePath: string, maxIncludeDepth = 10) {
  configuredFilePath = modelFilePath;
  configuredMaxDepth = maxIncludeDepth;
}

// ── Refresh ────────────────────────────────────────────────────────────

/**
 * Reads the local YAML file, validates it, then recursively fetches
 * and merges all remote include URLs. Rebuilds all indexes atomically.
 */
export async function refresh(): Promise<void> {
  const newModels = new Map<string, ModelWithSpecifier>();
  const newProviderIndex = new Map<string, string>();
  const newMerged: Record<string, Model> = {};

  const yamlText = await Bun.file(configuredFilePath).text();
  const yamlData = Bun.YAML.parse(yamlText);
  const { success, data } = ModelFileDefinitionSchema.safeParse(yamlData);
  if (!success) {
    throw new Error("Failed to validate model file during refresh");
  }

  indexModels(data.models, newModels, newProviderIndex, newMerged);

  const visited = new Set<string>();
  for (const includeUrl of data.includes ?? []) {
    await resolveIncludes(includeUrl, visited, 0, newModels, newProviderIndex, newMerged);
  }

  // Atomic swap
  modelData = newModels;
  providerModelIndex = newProviderIndex;
  mergedData = { models: newMerged };
}

async function resolveIncludes(
  url: string,
  visited: Set<string>,
  depth: number,
  models: Map<string, ModelWithSpecifier>,
  providerIndex: Map<string, string>,
  merged: Record<string, Model>,
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
    const yamlData = Bun.YAML.parse(text);
    const { success, data } = ModelFileDefinitionSchema.safeParse(yamlData);
    if (!success) {
      log.warn({ url }, "Include validation failed");
      return;
    }

    indexModels(data.models, models, providerIndex, merged);

    for (const nestedUrl of data.includes ?? []) {
      await resolveIncludes(nestedUrl, visited, depth + 1, models, providerIndex, merged);
    }
  } catch (err) {
    log.warn({ url, err }, "Include fetch error");
  }
}

function indexModels(
  source: Record<string, Model>,
  map: Map<string, ModelWithSpecifier>,
  providerIndex: Map<string, string>,
  merged: Record<string, Model>,
): void {
  for (const [specifier, model] of Object.entries(source)) {
    if (map.has(specifier)) {
      log.warn({ specifier }, "Duplicate model specifier, overwriting with later entry");
    }

    const entry: ModelWithSpecifier = { publicSpecifier: specifier, ...model };
    map.set(specifier, entry);
    merged[specifier] = model;

    for (const providerModel of Object.values(model.providers)) {
      if (providerModel) {
        providerIndex.set(providerModel, specifier);
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
  const result: Record<string, ModelWithSpecifier | null> = {};
  for (const spec of specifiers) {
    result[spec] = resolve(spec) ?? null;
  }
  return result;
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
