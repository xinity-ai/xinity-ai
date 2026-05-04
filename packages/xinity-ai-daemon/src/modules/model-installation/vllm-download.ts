import { env } from "../../env";
import { rootLogger } from "../../logger";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildRules, selectFiles } from "./file-filter";
import { ensureCacheSpace, getDirSize } from "./cache-eviction";

const log = rootLogger.child({ name: "vllm-download" });

const HF_API_URL = "https://huggingface.co";

interface HfFileEntry {
  path: string;
  size: number;
  lfs: { size: number } | null;
}

function authHeaders(): Record<string, string> {
  return env.VLLM_HF_TOKEN ? { Authorization: `Bearer ${env.VLLM_HF_TOKEN}` } : {};
}

function cleanEtag(raw: string): string {
  return raw.replace(/^W\//, "").replace(/"/g, "");
}

function fileSize(f: HfFileEntry): number {
  return f.lfs?.size ?? f.size;
}

async function hfFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...init?.headers } });
  if (!res.ok && res.status !== 206) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}. ${body}. URL: ${url}`);
  }
  return res;
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
): Promise<void> {
  const repoDir = path.join(env.VLLM_HF_CACHE_DIR, "hub", `models--${model.replace("/", "--")}`);
  const blobsDir = path.join(repoDir, "blobs");
  const refsDir = path.join(repoDir, "refs");

  fs.mkdirSync(blobsDir, { recursive: true });
  fs.mkdirSync(refsDir, { recursive: true });

  const { files: allFiles, commitHash } = await listRepoFiles(model);
  const { rules, mode } = buildRules(allFiles, userPatterns);
  const files = selectFiles(allFiles, rules);
  const totalBytes = files.reduce((sum, f) => sum + fileSize(f), 0);
  const droppedFiles = allFiles.length - files.length;
  const droppedBytes = allFiles.reduce((sum, f) => sum + fileSize(f), 0) - totalBytes;
  log.info(
    { model, fileCount: files.length, totalBytes, commitHash, mode, droppedFiles, droppedBytes },
    "Starting model download",
  );

  if (totalBytes === 0) {
    await onProgress(1);
    return;
  }

  const alreadyCachedBytes = getDirSize(repoDir);
  const requiredBytes = Math.max(0, totalBytes - alreadyCachedBytes);
  const eviction = await ensureCacheSpace({ requiredBytes, reservedModel: model });
  if (eviction.evicted.length > 0) {
    log.info(
      { model, evicted: eviction.evicted, freeBefore: eviction.freeBefore, freeAfter: eviction.freeAfter },
      "Evicted stale cache to make room for download",
    );
  }

  const snapshotDir = path.join(repoDir, "snapshots", commitHash);
  fs.mkdirSync(snapshotDir, { recursive: true });

  let downloadedBytes = 0;

  for (const file of files) {
    const { etag, bytesDownloaded } = await downloadFileToCache(model, file.path, blobsDir, commitHash, (bytes) => {
      downloadedBytes += bytes;
      return onProgress(downloadedBytes / totalBytes);
    });

    linkSnapshot(snapshotDir, file.path, path.join(blobsDir, etag));

    if (bytesDownloaded === 0) {
      downloadedBytes += fileSize(file);
      await onProgress(downloadedBytes / totalBytes);
    }
  }

  fs.writeFileSync(path.join(refsDir, "main"), commitHash);
  log.info({ model }, "Model download complete");
}

function linkSnapshot(snapshotDir: string, filePath: string, blobPath: string): void {
  const snapshotPath = path.join(snapshotDir, filePath);
  const parentDir = path.dirname(snapshotPath);
  fs.mkdirSync(parentDir, { recursive: true });
  try { fs.unlinkSync(snapshotPath); } catch { /* no existing link */ }
  fs.symlinkSync(path.relative(parentDir, blobPath), snapshotPath);
}

async function listRepoFiles(model: string): Promise<{ files: HfFileEntry[]; commitHash: string }> {
  const info = (await (await hfFetch(`${HF_API_URL}/api/models/${model}`)).json()) as { sha: string };

  const entries = (await (await hfFetch(
    `${HF_API_URL}/api/models/${model}/tree/${info.sha}?recursive=true`,
  )).json()) as Array<{ type: string; path: string; size: number; lfs?: { size: number } }>;

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
  onBytes: (bytes: number) => Promise<void>,
): Promise<{ etag: string; bytesDownloaded: number }> {
  const resolveUrl = `${HF_API_URL}/${model}/resolve/${commitHash}/${filePath}`;

  // Resolve etag (blob filename) via HEAD, preferring x-linked-etag
  const headRes = await hfFetch(resolveUrl, { method: "HEAD", redirect: "follow" });
  const rawEtag = headRes.headers.get("x-linked-etag") ?? headRes.headers.get("etag");
  if (!rawEtag) throw new Error(`No etag returned for ${filePath}`);

  const etag = cleanEtag(rawEtag);
  const blobPath = path.join(blobsDir, etag);

  if (fs.existsSync(blobPath)) return { etag, bytesDownloaded: 0 };

  const incompletePath = `${blobPath}.incomplete`;
  const existingBytes = getFileSize(incompletePath);

  const dlRes = await hfFetch(resolveUrl, {
    headers: existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {},
    redirect: "follow",
  });

  if (!dlRes.body) throw new Error(`No response body for ${filePath}`);

  const bytesDownloaded = await streamToFile(incompletePath, dlRes.body, existingBytes > 0 && dlRes.status === 206, onBytes);
  fs.renameSync(incompletePath, blobPath);

  return { etag, bytesDownloaded: bytesDownloaded + existingBytes };
}

function getFileSize(filePath: string): number {
  try { return fs.statSync(filePath).size; }
  catch { return 0; }
}

async function streamToFile(
  filePath: string,
  body: ReadableStream<Uint8Array>,
  append: boolean,
  onBytes: (bytes: number) => Promise<void>,
): Promise<number> {
  const fd = fs.openSync(filePath, append ? "a" : "w");
  let total = 0;
  try {
    for await (const chunk of body) {
      const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      fs.writeSync(fd, buf);
      total += buf.byteLength;
      await onBytes(buf.byteLength);
    }
  } finally {
    fs.closeSync(fd);
  }
  return total;
}
