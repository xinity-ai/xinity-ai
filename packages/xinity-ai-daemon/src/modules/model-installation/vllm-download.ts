import { listFiles, downloadFileToCacheDir } from "@huggingface/hub";
import { env } from "../../env";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "vllm-download" });

/**
 * Downloads a model's files into the HuggingFace cache directory using
 * the @huggingface/hub SDK. Reports byte-level progress via onProgress.
 *
 * The SDK writes to the standard HF cache layout (blobs/ + snapshots/),
 * which vllm reads on startup without needing to re-download.
 */
export async function downloadModel(
  model: string,
  onProgress: (progress: number) => Promise<void>,
): Promise<void> {
  const credentials = env.VLLM_HF_TOKEN ? { accessToken: env.VLLM_HF_TOKEN } : undefined;
  const cacheDir = env.VLLM_HF_CACHE_DIR;

  // 1. Enumerate files and compute total bytes
  const files: Array<{ path: string; size: number }> = [];
  for await (const entry of listFiles({ repo: model, recursive: true, ...credentials })) {
    if (entry.type !== "file") continue;
    files.push({ path: entry.path, size: entry.lfs?.size ?? entry.size });
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  log.info({ model, fileCount: files.length, totalBytes }, "Starting model download");

  if (totalBytes === 0) {
    await onProgress(1);
    return;
  }

  // 2. Download each file, tracking byte-level progress via a fetch wrapper
  let downloadedBytes = 0;

  for (const file of files) {
    const progressFetch = createProgressFetch((bytes) => {
      downloadedBytes += bytes;
      return onProgress(downloadedBytes / totalBytes);
    });

    await downloadFileToCacheDir({
      repo: model,
      path: file.path,
      cacheDir,
      fetch: progressFetch as typeof globalThis.fetch,
      ...credentials,
    });

    // If the file was already cached, downloadFileToCacheDir skips the
    // download entirely and our fetch wrapper never fires.  Advance
    // progress by the file's full size to keep the counter accurate.
    const expectedEnd = files
      .slice(0, files.indexOf(file) + 1)
      .reduce((s, f) => s + f.size, 0);
    if (downloadedBytes < expectedEnd) {
      downloadedBytes = expectedEnd;
      await onProgress(downloadedBytes / totalBytes);
    }
  }

  log.info({ model }, "Model download complete");
}

/**
 * Creates a fetch wrapper that intercepts response bodies to count bytes
 * flowing through. Calls `onBytes(chunkLength)` for each chunk read.
 */
function createProgressFetch(
  onBytes: (bytes: number) => Promise<void>,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const response = await fetch(input, init);

    if (!response.body) return response;

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        controller.enqueue(chunk);
        await onBytes(chunk.byteLength);
      },
    });

    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
