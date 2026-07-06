import { promises as fsp, readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import * as path from "node:path";
import { modelInstallationT, sql } from "common-db";
import { createInfoserverClient } from "xinity-infoserver";
import { env } from "../../env";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "cache-eviction" });

const SAFETY_MARGIN_BYTES = 1 * 1024 ** 3;

let _infoClient: ReturnType<typeof createInfoserverClient> | null = null;
function getInfoClient(): ReturnType<typeof createInfoserverClient> {
  if (!_infoClient) {
    _infoClient = createInfoserverClient({ baseUrl: env.INFOSERVER_URL, cacheTtlMs: env.INFOSERVER_CACHE_TTL_MS });
  }
  return _infoClient;
}

export interface CacheEntry {
  slug: string;
  model: string;
  dir: string;
  sizeBytes: number;
  mtime: Date;
}

export interface EvictionPlan {
  evict: CacheEntry[];
  freedBytes: number;
  sufficient: boolean;
}

/** Installation row reduced to what cache eviction needs. */
export interface InstallationCacheRecord {
  providerModel: string;
  deletedAt: Date | null;
}

export function slugForModel(model: string): string {
  return `models--${model.replace("/", "--")}`;
}

// A "--" inside the org or repo name itself would mismap here; the rare
// fallout is that the cache entry doesn't match its DB row and gets treated
// as orphaned (oldest-first by mtime), which is acceptable.
export function modelForSlug(slug: string): string {
  const stripped = slug.startsWith("models--") ? slug.slice("models--".length) : slug;
  const idx = stripped.indexOf("--");
  if (idx < 0) return stripped;
  return `${stripped.slice(0, idx)}/${stripped.slice(idx + 2)}`;
}

function readDirEntriesOrEmpty(dir: string): Dirent[] {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function safeFileSize(filePath: string): number {
  try { return statSync(filePath).size; } catch { return 0; }
}

export function getDirSize(dir: string): number {
  let total = 0;
  function walk(current: string): void {
    for (const entry of readDirEntriesOrEmpty(current)) {
      if (entry.isSymbolicLink()) continue;
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) walk(p);
      else total += safeFileSize(p);
    }
  }
  walk(dir);
  return total;
}

export async function getDiskFree(targetPath: string): Promise<number> {
  const stat = await fsp.statfs(targetPath);
  return Number(stat.bsize) * Number(stat.bavail);
}

function safeMtime(dir: string): Date {
  try { return statSync(dir).mtime; } catch { return new Date(0); }
}

export function listCacheEntries(hubDir: string): CacheEntry[] {
  let names: string[];
  try { names = readdirSync(hubDir); } catch { return []; }
  return names
    .filter((n) => n.startsWith("models--"))
    .map((slug): CacheEntry => {
      const dir = path.join(hubDir, slug);
      return { slug, model: modelForSlug(slug), dir, sizeBytes: getDirSize(dir), mtime: safeMtime(dir) };
    });
}

function latestDeletionDate(installations: readonly InstallationCacheRecord[], fallback: Date): Date {
  if (installations.length === 0) return fallback;
  return installations.reduce<Date>(
    (latest, m) => (m.deletedAt && m.deletedAt > latest ? m.deletedAt : latest),
    new Date(0),
  );
}

export function planEviction(input: {
  entries: readonly CacheEntry[];
  installations: readonly InstallationCacheRecord[];
  requiredBytes: number;
  reservedModel: string;
  freeBytes: number;
  safetyMarginBytes?: number;
}): EvictionPlan {
  const safetyMargin = input.safetyMarginBytes ?? SAFETY_MARGIN_BYTES;
  const target = input.requiredBytes + safetyMargin;

  if (input.freeBytes >= target) {
    return { evict: [], freedBytes: 0, sufficient: true };
  }

  const byProviderModel = Map.groupBy(input.installations, (i) => i.providerModel);

  type Candidate = CacheEntry & { lastNeededAt: Date };
  const candidates: Candidate[] = [];

  for (const entry of input.entries) {
    if (entry.model === input.reservedModel) continue;

    const matches = byProviderModel.get(entry.model) ?? [];
    if (matches.some((m) => m.deletedAt === null)) continue;

    const lastNeededAt = latestDeletionDate(matches, entry.mtime);
    candidates.push({ ...entry, lastNeededAt });
  }

  candidates.sort((a, b) => a.lastNeededAt.getTime() - b.lastNeededAt.getTime());

  const evict: CacheEntry[] = [];
  let freed = 0;
  for (const c of candidates) {
    if (input.freeBytes + freed >= target) break;
    evict.push(c);
    freed += c.sizeBytes;
  }

  return { evict, freedBytes: freed, sufficient: input.freeBytes + freed >= target };
}

export async function ensureCacheSpace(input: {
  requiredBytes: number;
  reservedModel: string;
}): Promise<{ evicted: { model: string; sizeBytes: number }[]; freeBefore: number; freeAfter: number }> {
  const cacheDir = env.VLLM_HF_CACHE_DIR;
  const hubDir = path.join(cacheDir, "hub");

  const freeBefore = await getDiskFree(cacheDir);
  if (freeBefore >= input.requiredBytes + SAFETY_MARGIN_BYTES) {
    return { evicted: [], freeBefore, freeAfter: freeBefore };
  }

  const entries = listCacheEntries(hubDir);
  const { getNodeId } = await import("../statekeeper");
  const { getDB } = await import("../../db/connection");
  const nodeId = await getNodeId();
  const installations = await getDB()
    .select()
    .from(modelInstallationT)
    .where(sql`${modelInstallationT.nodeId} = ${nodeId}`);

  // Resolve each installation's canonical specifier to its provider-side cache key.
  // Installations the catalog cannot resolve are dropped from the eviction view:
  // their cache directories will be treated as orphaned and ranked by mtime.
  const cacheRecords: InstallationCacheRecord[] = [];
  for (const i of installations) {
    const model = await getInfoClient().fetchModel(i.specifier);
    const providerModel = model?.providers.vllm;
    if (!providerModel) continue;
    cacheRecords.push({ providerModel, deletedAt: i.deletedAt });
  }

  const plan = planEviction({
    entries,
    installations: cacheRecords,
    requiredBytes: input.requiredBytes,
    reservedModel: input.reservedModel,
    freeBytes: freeBefore,
  });

  if (!plan.sufficient) {
    throw new Error(
      `Cannot free enough cache space for ${input.reservedModel}: ` +
      `need ${input.requiredBytes} bytes, ${freeBefore} free, ` +
      `only ${plan.freedBytes} additional bytes evictable across ${plan.evict.length} stale model(s)`,
    );
  }

  for (const entry of plan.evict) {
    log.info(
      { model: entry.model, sizeBytes: entry.sizeBytes, dir: entry.dir },
      "Evicting stale model cache",
    );
    rmSync(entry.dir, { recursive: true, force: true });
  }

  const freeAfter = await getDiskFree(cacheDir);
  return {
    evicted: plan.evict.map((e) => ({ model: e.model, sizeBytes: e.sizeBytes })),
    freeBefore,
    freeAfter,
  };
}
