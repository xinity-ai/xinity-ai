import type { Dirent } from "node:fs";
import { readdir, rm, stat, statfs } from "node:fs/promises";
import * as path from "node:path";
import { config } from "../../config";
import { rootLogger } from "../../logger";
import { resolveInstallationEntry } from "./catalog";

const log = rootLogger.child({ name: "cache-eviction" });

const SAFETY_MARGIN_BYTES = 1 * 1024 ** 3;

export type CacheEntry = {
  slug: string;
  model: string;
  dir: string;
  sizeBytes: number;
  mtime: Date;
}

export type EvictionPlan = {
  evict: CacheEntry[];
  freedBytes: number;
  sufficient: boolean;
}

/** Installation row reduced to what cache eviction needs. */
export type InstallationCacheRecord = {
  providerModel: string;
  deletedAt: Date | null;
}

export function slugForModel(model: string): string {
  return `models--${model.replace("/", "--")}`;
}

export function modelForSlug(slug: string): string {
  const stripped = slug.startsWith("models--") ? slug.slice("models--".length) : slug;
  const idx = stripped.indexOf("--");
  if (idx < 0) {
    return stripped;
  }
  return `${stripped.slice(0, idx)}/${stripped.slice(idx + 2)}`;
}

async function readDirEntriesOrEmpty(dir: string): Promise<Dirent[]> {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function safeFileSize(filePath: string): Promise<number> {
  try { return (await stat(filePath)).size; } catch { return 0; }
}

export async function getDirSize(dir: string): Promise<number> {
  let total = 0;
  async function walk(current: string): Promise<void> {
    for (const entry of await readDirEntriesOrEmpty(current)) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else {
        total += await safeFileSize(p);
      }
    }
  }
  await walk(dir);
  return total;
}

export async function getDiskFree(targetPath: string): Promise<number> {
  const fsStat = await statfs(targetPath);
  return Number(fsStat.bsize) * Number(fsStat.bavail);
}

async function safeMtime(dir: string): Promise<Date> {
  try { return (await stat(dir)).mtime; } catch { return new Date(0); }
}

export async function listCacheEntries(hubDir: string): Promise<CacheEntry[]> {
  let names: string[];
  try { names = await readdir(hubDir); } catch { return []; }
  const entries: CacheEntry[] = [];
  for (const slug of names.filter((n) => n.startsWith("models--"))) {
    const dir = path.join(hubDir, slug);
    entries.push({ slug, model: modelForSlug(slug), dir, sizeBytes: await getDirSize(dir), mtime: await safeMtime(dir) });
  }
  return entries;
}

function latestDeletionDate(installations: readonly InstallationCacheRecord[], fallback: Date): Date {
  if (installations.length === 0) {
    return fallback;
  }
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
    if (entry.model === input.reservedModel) {
      continue;
    }

    const matches = byProviderModel.get(entry.model) ?? [];
    if (matches.some((m) => m.deletedAt === null)) {
      continue;
    }

    const lastNeededAt = latestDeletionDate(matches, entry.mtime);
    candidates.push({ ...entry, lastNeededAt });
  }

  candidates.sort((a, b) => a.lastNeededAt.getTime() - b.lastNeededAt.getTime());

  const evict: CacheEntry[] = [];
  let freed = 0;
  for (const c of candidates) {
    if (input.freeBytes + freed >= target) {
      break;
    }
    evict.push(c);
    freed += c.sizeBytes;
  }

  return { evict, freedBytes: freed, sufficient: input.freeBytes + freed >= target };
}

/**
 * The margin keeps a download from filling the disk as it writes. A model already in the
 * cache writes nothing, so demanding headroom for it refuses a start that would have
 * touched no bytes, and eviction cannot help: the reserved model is what fills the disk.
 */
export function needsCacheSpace(
  requiredBytes: number,
  freeBytes: number,
  safetyMarginBytes: number = SAFETY_MARGIN_BYTES,
): boolean {
  return requiredBytes > 0 && freeBytes < requiredBytes + safetyMarginBytes;
}

export async function ensureCacheSpace(input: {
  requiredBytes: number;
  reservedModel: string;
}): Promise<{ evicted: { model: string; sizeBytes: number }[]; freeBefore: number; freeAfter: number }> {
  const cacheDir = config.vllm.hfCacheDir;
  const hubDir = path.join(cacheDir, "hub");

  const freeBefore = await getDiskFree(cacheDir);
  if (!needsCacheSpace(input.requiredBytes, freeBefore)) {
    return { evicted: [], freeBefore, freeAfter: freeBefore };
  }

  const entries = await listCacheEntries(hubDir);
  const { getDesiredInstallations } = await import("../db-sync");
  const installations = getDesiredInstallations();

  const cacheRecords: InstallationCacheRecord[] = [];
  for (const i of installations) {
    const entry = await resolveInstallationEntry(i.specifier, "vllm");
    if (!entry) {
      continue;
    }
    cacheRecords.push({ providerModel: entry.engineSpecifier, deletedAt: null });
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
    await rm(entry.dir, { recursive: true, force: true });
  }

  const freeAfter = await getDiskFree(cacheDir);
  return {
    evicted: plan.evict.map((e) => ({ model: e.model, sizeBytes: e.sizeBytes })),
    freeBefore,
    freeAfter,
  };
}
