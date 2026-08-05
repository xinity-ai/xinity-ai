/**
 * Owns the two catalogs the server runs side by side. Nothing is projected
 * between them, so an entry is only ever served on an endpoint of its own format.
 */
import {
  type LegacyModel,
  type Model,
  LegacyModelFileSchema,
  ModelFileSchema,
} from "./definitions/model-definition";
import { createCatalog, type FileParseOutcome } from "./catalog";
import { rootLogger } from "./logger";
import { z } from "zod";

const log = rootLogger.child({ name: "catalog" });

function parseWith<M>(schema: z.ZodType) {
  return (text: string): FileParseOutcome<M> => {
    const parsed = schema.safeParse(Bun.YAML.parse(text));
    return parsed.success
      ? { status: "ok", file: parsed.data as { models: Record<string, M>; includes?: string[] } }
      : { status: "invalid", reason: z.prettifyError(parsed.error) };
  };
}

export const modelCatalog = createCatalog<Model>({
  name: "current-format",
  parseFile: parseWith<Model>(ModelFileSchema),
  invalidDocumentIsFatal: true,
});

export const legacyCatalog = createCatalog<LegacyModel>({
  name: "deprecated v1",
  parseFile: parseWith<LegacyModel>(LegacyModelFileSchema),
  invalidDocumentIsFatal: false,
});

let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function configure(
  maxIncludeDepth = 10,
  modelDirPath?: string,
  legacyDirPath?: string,
): void {
  modelCatalog.configure({ dirPath: modelDirPath, maxIncludeDepth });
  legacyCatalog.configure({ dirPath: legacyDirPath, maxIncludeDepth });

  if (legacyDirPath) {
    log.warn(
      { legacyDirPath },
      "MODEL_LEGACY_DIR serves the deprecated v1 model format and will be removed before 1.0.0. Migrate its entries to the current format under MODEL_INFO_DIR",
    );
  }
}

export async function refresh(): Promise<void> {
  await Promise.all([modelCatalog.refresh(), legacyCatalog.refresh()]);
}

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
    models: modelCatalog.getHealth(),
    legacy: legacyCatalog.getHealth(),
  };
}
