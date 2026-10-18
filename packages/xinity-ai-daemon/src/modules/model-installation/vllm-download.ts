import { config } from "../../config";
import { rootLogger } from "../../logger";
import { mkdir, open, readdir, readFile, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { buildRules, selectFiles } from "./file-filter";
import { ensureCacheSpace, getDirSize } from "./cache-eviction";

const log = rootLogger.child({ name: "vllm-download" });

export function hfUrl(pathname: string): string {
  return `${config.hfEndpoint.replace(/\/+$/, "")}${pathname}`;
}

type HfFileEntry = {
  path: string;
  size: number;
  lfs: { size: number } | null;
}

function authHeaders(): Record<string, string> {
  const hfToken = config.vllm.hfToken();
  return hfToken ? { Authorization: `Bearer ${hfToken}` } : {};
}

function cleanEtag(raw: string): string {
  return raw.replace(/^W\//, "").replace(/"/g, "");
}

function fileSize(f: HfFileEntry): number {
  return f.lfs?.size ?? f.size;
}

function sumFileSizes(files: readonly HfFileEntry[]): number {
  return files.reduce((sum, f) => sum + fileSize(f), 0);
}

async function hfFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...init?.headers } });
  if (!res.ok && res.status !== 206 && res.status !== 416) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}. ${body}. URL: ${url}`);
  }
  return res;
}

async function hfFetchJson<T>(url: string): Promise<T> {
  return (await hfFetch(url)).json() as Promise<T>;
}

/**
 * Downloads model files into the HuggingFace cache directory, writing the
 * standard blob/snapshot/ref layout that vllm reads on startup. Supports
 * resuming partial downloads via Range headers and .incomplete files.
 */
export async function downloadModel(
  model: string,
  onProgress: (progress: number) => Promise<void>,
  userPatterns: readonly string[] = [],
  stallMs = 60_000,
): Promise<void> {
  const repoDir = cachedRepoDir(model);
  const blobsDir = path.join(repoDir, "blobs");
  const refsDir = path.join(repoDir, "refs");

  await mkdir(blobsDir, { recursive: true });
  await mkdir(refsDir, { recursive: true });

  const { files: allFiles, commitHash } = await listRepoFiles(model);
  const { rules, mode } = buildRules(allFiles, userPatterns);
  const files = selectFiles(allFiles, rules);
  const totalBytes = sumFileSizes(files);
  const droppedFiles = allFiles.length - files.length;
  const droppedBytes = sumFileSizes(allFiles) - totalBytes;
  log.info(
    { model, fileCount: files.length, totalBytes, commitHash, mode, droppedFiles, droppedBytes },
    "Starting model download",
  );

  if (totalBytes === 0) {
    await onProgress(1);
    return;
  }

  const alreadyCachedBytes = await getDirSize(repoDir);
  const requiredBytes = Math.max(0, totalBytes - alreadyCachedBytes);
  const eviction = await ensureCacheSpace({ requiredBytes, reservedModel: model });
  if (eviction.evicted.length > 0) {
    log.info(
      { model, evicted: eviction.evicted, freeBefore: eviction.freeBefore, freeAfter: eviction.freeAfter },
      "Evicted stale cache to make room for download",
    );
  }

  const snapshotDir = path.join(repoDir, "snapshots", commitHash);
  await mkdir(snapshotDir, { recursive: true });

  let completedBytes = 0;

  for (const file of files) {
    let streamedBytes = 0;
    const etag = await downloadFileToCache(model, file.path, blobsDir, commitHash, fileSize(file), stallMs, (bytes) => {
      streamedBytes += bytes;
      return onProgress((completedBytes + streamedBytes) / totalBytes);
    });

    await linkSnapshot(snapshotDir, file.path, path.join(blobsDir, etag));

    completedBytes += fileSize(file);
    await onProgress(completedBytes / totalBytes);
  }

  await writeFile(path.join(refsDir, "main"), commitHash);
  log.info({ model }, "Model download complete");
}

function cachedRepoDir(model: string): string {
  return path.join(config.vllm.hfCacheDir, "hub", `models--${model.replace("/", "--")}`);
}

const WEIGHT_FILE = /\.(safetensors|bin|pth?)$/;

export async function largestWeightFileBytes(model: string): Promise<number> {
  const listed = await listRepoFiles(model).then(({ files }) => files, () => undefined);
  if (listed) {
    return Math.max(0, ...listed.filter((file) => WEIGHT_FILE.test(file.path)).map(fileSize));
  }
  const repoDir = cachedRepoDir(model);
  const commitHash = await readFile(path.join(repoDir, "refs", "main"), "utf8").catch(() => "");
  const snapshotDir = path.join(repoDir, "snapshots", commitHash.trim());
  const files = commitHash ? await readdir(snapshotDir, { recursive: true }).catch(() => []) : [];
  const sizes = await Promise.all(files.filter((file) => WEIGHT_FILE.test(file)).map((file) => getFileSize(path.join(snapshotDir, file))));
  return Math.max(0, ...sizes);
}

async function linkSnapshot(snapshotDir: string, filePath: string, blobPath: string): Promise<void> {
  const snapshotPath = path.join(snapshotDir, filePath);
  const parentDir = path.dirname(snapshotPath);
  await mkdir(parentDir, { recursive: true });
  await unlink(snapshotPath).catch(() => { /* no existing link */ });
  await symlink(path.relative(parentDir, blobPath), snapshotPath);
}

async function listRepoFiles(model: string): Promise<{ files: HfFileEntry[]; commitHash: string }> {
  const info = await hfFetchJson<{ sha: string }>(hfUrl(`/api/models/${model}`));

  const entries = await hfFetchJson<Array<{ type: string; path: string; size: number; lfs?: { size: number } }>>(
    hfUrl(`/api/models/${model}/tree/${info.sha}?recursive=true`),
  );

  return {
    commitHash: info.sha,
    files: entries
      .filter((e) => e.type === "file")
      .map((e) => ({ path: e.path, size: e.size, lfs: e.lfs ?? null })),
  };
}

async function downloadFileToCache(
  model: string,
  filePath: string,
  blobsDir: string,
  commitHash: string,
  expectedSize: number,
  stallMs: number,
  onBytes: (bytes: number) => Promise<void>,
): Promise<string> {
  const resolveUrl = hfUrl(`/${model}/resolve/${commitHash}/${filePath}`);

  // Resolve etag (blob filename) via HEAD, preferring x-linked-etag
  const headRes = await hfFetch(resolveUrl, { method: "HEAD", redirect: "follow" });
  const rawEtag = headRes.headers.get("x-linked-etag") ?? headRes.headers.get("etag");
  if (!rawEtag) throw new Error(`No etag returned for ${filePath}`);

  const etag = cleanEtag(rawEtag);
  const blobPath = path.join(blobsDir, etag);

  if (await Bun.file(blobPath).exists()) return etag;

  const incompletePath = `${blobPath}.incomplete`;
  let attemptsWithoutBytes = 0;

  for (;;) {
    const existingBytes = await getFileSize(incompletePath);
    if (existingBytes > 0 && existingBytes === expectedSize) {
      await rename(incompletePath, blobPath);
      return etag;
    }

    const stall = stallWatchdog(stallMs);
    try {
      const { response: dlRes, existingBytes: resumeBytes } = await fetchBlobResumable(
        resolveUrl,
        incompletePath,
        existingBytes,
        stall.signal,
      );
      if (!dlRes.body) throw new Error(`No response body for ${filePath}`);
      await streamToFile(incompletePath, dlRes.body, resumeBytes > 0 && dlRes.status === 206, stall.signal, (bytes) => {
        stall.reset();
        return onBytes(bytes);
      });
      await rename(incompletePath, blobPath);
      return etag;
    } catch (err) {
      if (!stall.signal.aborted) {
        throw err;
      }
      // A connection that dies without closing never ends the read, so only a timeout notices it.
      attemptsWithoutBytes = (await getFileSize(incompletePath)) > existingBytes ? 0 : attemptsWithoutBytes + 1;
      if (attemptsWithoutBytes >= STALLED_ATTEMPTS) {
        throw new Error(`Download of ${filePath} stalled: no data for ${stallMs / 1000}s, ${STALLED_ATTEMPTS} times in a row`, { cause: err });
      }
      log.warn({ model, filePath, stallMs }, "Download stalled, resuming");
    } finally {
      stall.stop();
    }
  }
}

const STALLED_ATTEMPTS = 5;

function stallWatchdog(stallMs: number) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), stallMs);
  return {
    signal: controller.signal,
    reset: () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), stallMs);
    },
    stop: () => clearTimeout(timer),
  };
}

async function fetchBlobResumable(
  resolveUrl: string,
  incompletePath: string,
  existingBytes: number,
  signal: AbortSignal,
): Promise<{ response: Response; existingBytes: number }> {
  let response = await hfFetch(resolveUrl, {
    headers: existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {},
    redirect: "follow",
    signal,
  });

  if (response.status === 416) {
    await response.body?.cancel();
    await unlink(incompletePath);
    existingBytes = 0;
    response = await hfFetch(resolveUrl, { redirect: "follow", signal });
  }

  return { response, existingBytes };
}

async function getFileSize(filePath: string): Promise<number> {
  try { return (await stat(filePath)).size; }
  catch { return 0; }
}

async function streamToFile(
  filePath: string,
  body: ReadableStream<Uint8Array>,
  append: boolean,
  signal: AbortSignal,
  onBytes: (bytes: number) => Promise<void>,
): Promise<void> {
  const file = await open(filePath, append ? "a" : "w");
  const reader = body.getReader();
  const cancel = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const buf = read.value instanceof Uint8Array ? read.value : new Uint8Array(read.value);
      await file.write(buf);
      await onBytes(buf.byteLength);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    await file.close();
  }
}
