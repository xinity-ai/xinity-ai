/**
 * A factory rather than a module, because the server runs two of these side by
 * side, one per model format, with no data crossing between them.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { rootLogger } from "./logger";

/** Without this an unresponsive include host stalls every later refresh behind it. */
const INCLUDE_FETCH_TIMEOUT_MS = 10_000;

export type Indexed<M> = M & { publicSpecifier: string; _source: string };

export interface ParsedModelFile<M> {
  models: Record<string, M>;
  includes?: string[];
}

export type FileParseOutcome<M> =
  | { status: "ok"; file: ParsedModelFile<M>; skippedEntries?: number }
  | { status: "invalid"; reason: string };

export interface SerializedCatalog {
  json: string;
  yaml: string;
  /** Content hash, usable as an ETag and as a change signal for clients. */
  digest: string;
}

export interface CatalogHealth {
  modelCount: number;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
}

interface CatalogModel {
  family?: string;
}

export interface CatalogOptions<M> {
  /** Distinguishes the two catalogs in logs. */
  name: string;
  parseFile: (text: string) => FileParseOutcome<M>;
  parseRemoteFile?: (text: string) => FileParseOutcome<M>;
  /**
   * When false, a document that fails validation is skipped with a warning. Only
   * the deprecated format does that, so tightening this cannot stop a deployment
   * that starts today from starting after an upgrade.
   */
  invalidDocumentIsFatal: boolean;
}

interface CatalogConfig {
  dirPath: string | undefined;
  maxIncludeDepth: number;
}

export interface Catalog<M> {
  configure(config: CatalogConfig): void;
  refresh(): Promise<void>;
  get(specifier: string): Indexed<M> | undefined;
  resolveBatch(specifiers: string[]): Record<string, Indexed<M> | null>;
  getAll(): Indexed<M>[];
  getByFamily(family: string): Indexed<M>[];
  getMergedData(): { models: Record<string, M> };
  getSerializedCatalog(): SerializedCatalog;
  getHealth(): CatalogHealth;
}

/**
 * Sorted so the digest tracks content only. Merge order follows load order, so an
 * include that reorders its own keys would otherwise look like a change.
 */
function serializeCatalog<M>(models: Record<string, M>): SerializedCatalog {
  const sorted: Record<string, M> = {};
  for (const specifier of Object.keys(models).sort()) {
    sorted[specifier] = models[specifier]!;
  }

  const payload = { models: sorted };
  const json = JSON.stringify(payload);
  return {
    json,
    yaml: Bun.YAML.stringify(payload),
    digest: new Bun.CryptoHasher("sha256").update(json).digest("hex"),
  };
}

export function createCatalog<M extends CatalogModel>(options: CatalogOptions<M>): Catalog<M> {
  const log = rootLogger.child({ name: `catalog:${options.name}` });

  let modelData = new Map<string, Indexed<M>>();
  let mergedData: { models: Record<string, M> } = { models: {} };
  let serialized = serializeCatalog(mergedData.models);

  let dirPath: string | undefined;
  let maxIncludeDepth = 10;

  let lastRefreshAt: Date | null = null;
  let lastRefreshError: string | null = null;

  type IndexState = {
    models: Map<string, Indexed<M>>;
    merged: Record<string, M>;
    localSpecifiers: Set<string>;
  };

  function indexModels(
    source: Record<string, M>,
    sourceLabel: string,
    isLocal: boolean,
    state: IndexState,
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

      state.models.set(specifier, { publicSpecifier: specifier, _source: sourceLabel, ...model });
      state.merged[specifier] = model;

      if (isLocal) {
        state.localSpecifiers.add(specifier);
      }
    }
  }

  async function resolveIncludes(
    url: string,
    visited: Set<string>,
    depth: number,
    state: IndexState,
  ): Promise<void> {
    if (depth >= maxIncludeDepth) {
      log.warn({ url, maxDepth: maxIncludeDepth }, "Max include depth reached, skipping");
      return;
    }

    if (visited.has(url)) {
      log.warn({ url }, "Cycle detected, skipping already-visited include");
      return;
    }
    visited.add(url);

    let outcome: FileParseOutcome<M>;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(INCLUDE_FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        log.warn({ url, status: response.status }, "Include fetch failed");
        return;
      }
      outcome = (options.parseRemoteFile ?? options.parseFile)(await response.text());
    } catch (err) {
      log.warn({ url, err }, "Include fetch error");
      return;
    }

    // An include URL is written by the operator and names a versioned document, so a
    // document that does not validate means the URL is wrong, not that a remote is
    // having a bad day.
    if (outcome.status === "invalid") {
      if (options.invalidDocumentIsFatal) {
        throw new Error(`${url} is not a valid ${options.name} model document:\n${outcome.reason}`);
      }
      log.warn({ url, reason: outcome.reason }, "Include validation failed, skipping");
      return;
    }

    if (outcome.skippedEntries) {
      log.warn({ url, skipped: outcome.skippedEntries }, "Include carries entries this build cannot use");
    }

    indexModels(outcome.file.models, url, false, state);

    for (const nestedUrl of outcome.file.includes ?? []) {
      await resolveIncludes(nestedUrl, visited, depth + 1, state);
    }
  }

  async function loadDirectoryFiles(directory: string, visited: Set<string>, state: IndexState): Promise<void> {
    let entries: string[];
    try {
      entries = (await readdir(directory))
        .filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
        .sort();
    } catch (err) {
      log.warn({ dirPath: directory, err }, "Could not read model info directory, skipping");
      return;
    }

    if (entries.length === 0) {
      log.debug({ dirPath: directory }, "Model info directory is empty");
      return;
    }

    for (const filename of entries) {
      const filePath = join(directory, filename);

      // A file the operator put here that the server cannot read is a configuration
      // error. Skipping it would serve a quietly smaller catalog, which surfaces much
      // later as deployments that will not schedule.
      let outcome: FileParseOutcome<M>;
      try {
        outcome = options.parseFile(await Bun.file(filePath).text());
      } catch (err) {
        if (options.invalidDocumentIsFatal) {
          throw err;
        }
        log.warn({ filePath, err }, "Failed to load model file from directory, skipping");
        continue;
      }

      if (outcome.status === "invalid") {
        if (options.invalidDocumentIsFatal) {
          throw new Error(`${filePath} is not a valid ${options.name} model file:\n${outcome.reason}`);
        }
        log.warn({ filePath, reason: outcome.reason }, "Model file validation failed, skipping");
        continue;
      }

      log.debug({ filePath, modelCount: Object.keys(outcome.file.models).length }, "Loaded model file from directory");
      indexModels(outcome.file.models, filePath, true, state);

      for (const includeUrl of outcome.file.includes ?? []) {
        await resolveIncludes(includeUrl, visited, 0, state);
      }
    }
  }

  return {
    configure(config) {
      dirPath = config.dirPath;
      maxIncludeDepth = config.maxIncludeDepth;
    },

    async refresh() {
      const state: IndexState = { models: new Map(), merged: {}, localSpecifiers: new Set() };

      try {
        if (dirPath) {
          await loadDirectoryFiles(dirPath, new Set(), state);
        }

        // Atomic swap
        modelData = state.models;
        mergedData = { models: state.merged };
        serialized = serializeCatalog(mergedData.models);
        lastRefreshAt = new Date();
        lastRefreshError = null;
      } catch (err) {
        lastRefreshError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    },

    get(specifier) {
      return modelData.get(specifier);
    },

    resolveBatch(specifiers) {
      return Object.fromEntries(specifiers.map(spec => [spec, modelData.get(spec) ?? null]));
    },

    getAll() {
      return Array.from(modelData.values());
    },

    getByFamily(family) {
      return Array.from(modelData.values()).filter(m => (m.family ?? "unknown") === family);
    },

    getMergedData() {
      return mergedData;
    },

    getSerializedCatalog() {
      return serialized;
    },

    getHealth() {
      return {
        modelCount: modelData.size,
        lastRefreshAt: lastRefreshAt?.toISOString() ?? null,
        lastRefreshError,
      };
    },
  };
}
