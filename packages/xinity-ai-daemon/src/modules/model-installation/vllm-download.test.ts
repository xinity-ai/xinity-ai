import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { mockDaemonConfig } from "../../mock-config";
import type { FileSource } from "./vllm-download";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock env before importing module under test
const testCacheDir = path.join(os.tmpdir(), `hf-download-test-${Date.now()}`);

mock.module("../../config", () => ({ config: mockDaemonConfig({ VLLM_HF_CACHE_DIR: testCacheDir }) }));

mock.module("../../logger", () => ({
  rootLogger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

const { downloadModel, hfUrl, largestWeightFileBytes } = await import("./vllm-download");
const { config } = await import("../../config");

describe("hfUrl", () => {
  test("keeps a mirror's path prefix and drops its trailing slash", () => {
    const configured = config.hfEndpoint;
    config.hfEndpoint = "https://repo.example/artifactory/api/huggingfaceml/hf/";
    try {
      expect(hfUrl("/api/models/org/model")).toBe(
        "https://repo.example/artifactory/api/huggingfaceml/hf/api/models/org/model",
      );
    } finally {
      config.hfEndpoint = configured;
    }
  });
});

// ---------------------------------------------------------------------------
// These tests hit the real HuggingFace API. They use a tiny public model
// to keep download times minimal. Skipped by default because they need
// network; un-skip to validate downloading on demand.
// ---------------------------------------------------------------------------

const TINY_MODEL = "hf-internal-testing/tiny-random-gpt2";

describe.skip("downloadModel (integration, real HF API)", () => {
  beforeEach(() => {
    fs.mkdirSync(testCacheDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  test("downloads a tiny model and reports progress", async () => {
    const progressValues: number[] = [];
    await downloadModel(TINY_MODEL, async (progress) => {
      progressValues.push(progress);
    });

    // Progress should start > 0 and end at 1
    expect(progressValues.length).toBeGreaterThan(0);
    expect(progressValues[progressValues.length - 1]).toBeCloseTo(1, 1);

    // Progress should be monotonically increasing
    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]!).toBeGreaterThanOrEqual(progressValues[i - 1]!);
    }

    // Cache structure should exist
    const repoDir = path.join(testCacheDir, "hub", `models--${TINY_MODEL.replace("/", "--")}`);
    expect(fs.existsSync(path.join(repoDir, "blobs"))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, "refs", "main"))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, "snapshots"))).toBe(true);

    // refs/main should contain a commit hash (40 hex chars)
    const commitHash = fs.readFileSync(path.join(repoDir, "refs", "main"), "utf-8");
    expect(commitHash).toMatch(/^[a-f0-9]{40}$/);

    // Snapshots should contain symlinks to blobs
    const snapshotDir = path.join(repoDir, "snapshots", commitHash);
    expect(fs.existsSync(snapshotDir)).toBe(true);
    const snapshotFiles = fs.readdirSync(snapshotDir);
    expect(snapshotFiles.length).toBeGreaterThan(0);

    // Each snapshot file should be a symlink pointing to blobs
    for (const file of snapshotFiles) {
      const filePath = path.join(snapshotDir, file);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(filePath);
        expect(target).toContain("blobs");
        // The blob target should actually exist
        const resolved = path.resolve(snapshotDir, target);
        expect(fs.existsSync(resolved)).toBe(true);
      }
    }
  }, 30_000);

  test("second download is a no-op (files already cached)", async () => {
    // First download
    await downloadModel(TINY_MODEL, async () => {});

    // Second download should skip everything
    const progressValues: number[] = [];
    await downloadModel(TINY_MODEL, async (progress) => {
      progressValues.push(progress);
    });

    // Progress should still reach 1, but via cache-skip jumps
    expect(progressValues[progressValues.length - 1]).toBeCloseTo(1, 1);
  }, 30_000);

  test("resume works after partial download", async () => {
    // First, do a full download to discover the cache structure
    await downloadModel(TINY_MODEL, async () => {});

    const repoDir = path.join(testCacheDir, "hub", `models--${TINY_MODEL.replace("/", "--")}`);
    const blobsDir = path.join(repoDir, "blobs");
    const blobs = fs.readdirSync(blobsDir);

    // Find the largest blob to simulate a partial download
    let largestBlob = "";
    let largestSize = 0;
    for (const blob of blobs) {
      const size = fs.statSync(path.join(blobsDir, blob)).size;
      if (size > largestSize) {
        largestSize = size;
        largestBlob = blob;
      }
    }

    if (largestSize < 10) {
      // All files too small to meaningfully test resume, skip
      return;
    }

    // Simulate a partial download: truncate the largest blob and rename to .incomplete
    const blobPath = path.join(blobsDir, largestBlob);
    const incompletePath = `${blobPath}.incomplete`;
    const partialSize = Math.floor(largestSize / 2);

    const fullData = fs.readFileSync(blobPath);
    fs.unlinkSync(blobPath); // Remove the complete blob
    fs.writeFileSync(incompletePath, fullData.subarray(0, partialSize));

    // Re-download should resume and complete
    await downloadModel(TINY_MODEL, async () => {});

    // The blob should be fully restored
    expect(fs.existsSync(blobPath)).toBe(true);
    expect(fs.existsSync(incompletePath)).toBe(false);
    const restoredSize = fs.statSync(blobPath).size;
    expect(restoredSize).toBe(largestSize);
  }, 30_000);
});

describe("downloadModel resume edge cases", () => {
  const model = "test/model";
  const commitHash = "a".repeat(40);
  const blobsDir = path.join(testCacheDir, "hub", `models--${model.replace("/", "--")}`, "blobs");
  const blobPath = (file: string) => path.join(blobsDir, `etag-${file}`);
  const incompletePath = (file: string) => `${blobPath(file)}.incomplete`;
  const contents = new TextEncoder().encode("0123456789");

  beforeEach(() => {
    fs.mkdirSync(blobsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  /** Serves `files` from a mocked Hugging Face; `respond` may override the answer to the nth GET of a file. */
  async function downloadFrom(
    files: Record<string, Uint8Array>,
    respond: (file: string, attempt: number) => Response | undefined = () => undefined,
    { stallMs, source }: { stallMs?: number; source?: FileSource } = {},
  ) {
    const gets: { file: string; headers: RequestInit["headers"] }[] = [];
    const progress: number[] = [];
    const resolvePrefix = `https://huggingface.co/${model}/resolve/${commitHash}/`;

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input);
      if (url === `https://huggingface.co/api/models/${model}`) {
        return Response.json({ sha: commitHash });
      }
      if (url === `https://huggingface.co/api/models/${model}/tree/${commitHash}?recursive=true`) {
        return Response.json(Object.entries(files).map(([file, bytes]) => ({ type: "file", path: file, size: bytes.byteLength })));
      }
      const file = url.startsWith(resolvePrefix) ? url.slice(resolvePrefix.length) : undefined;
      if (file === undefined || !(file in files)) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      if (init?.method === "HEAD") {
        return new Response(null, { headers: { etag: `"etag-${file}"` } });
      }
      gets.push({ file, headers: init?.headers ?? {} });
      const attempt = gets.filter((g) => g.file === file).length;
      return respond(file, attempt) ?? new Response(files[file]);
    }) as typeof fetch);

    try {
      await downloadModel(model, async (value) => {
        progress.push(value);
      }, [], { stallMs, source });
    } finally {
      fetchSpy.mockRestore();
    }
    return { gets, progress };
  }

  test("retries from scratch when an oversized .incomplete file gets a 416", async () => {
    const staleContents = new TextEncoder().encode("01234567890");
    fs.writeFileSync(incompletePath("model.safetensors"), staleContents);

    const { gets, progress } = await downloadFrom({ "model.safetensors": contents }, (_file, attempt) =>
      attempt === 1 ? new Response(null, { status: 416 }) : undefined,
    );

    expect(gets).toHaveLength(2);
    expect(gets[0]?.headers).toEqual(expect.objectContaining({ Range: `bytes=${staleContents.byteLength}-` }));
    expect(gets[1]?.headers).not.toEqual(expect.objectContaining({ Range: expect.any(String) }));
    expect(progress.at(-1)).toBe(1);
    expect(fs.existsSync(incompletePath("model.safetensors"))).toBe(false);
    expect(new Uint8Array(fs.readFileSync(blobPath("model.safetensors")))).toEqual(contents);
  });

  test("downloads an empty file that has no partial download yet", async () => {
    const { gets, progress } = await downloadFrom({ "model.safetensors": contents, "empty.txt": new Uint8Array(0) });

    expect(gets.map((g) => g.file)).toContain("empty.txt");
    expect(fs.statSync(blobPath("empty.txt")).size).toBe(0);
    expect(progress.at(-1)).toBe(1);
  });

  test("moves an .incomplete file that is already full size into place without fetching it", async () => {
    fs.writeFileSync(incompletePath("model.safetensors"), contents);

    const { gets, progress } = await downloadFrom({ "model.safetensors": contents });

    expect(gets).toHaveLength(0);
    expect(new Uint8Array(fs.readFileSync(blobPath("model.safetensors")))).toEqual(contents);
    expect(progress.at(-1)).toBe(1);
  });

  const hangingAfter = (bytes: Uint8Array) => new Response(new ReadableStream({ start: (controller) => controller.enqueue(bytes) }));

  test("resumes a download whose connection stops sending without closing", async () => {
    const { gets, progress } = await downloadFrom(
      { "model.safetensors": contents },
      (_file, attempt) => (attempt === 1 ? hangingAfter(contents.subarray(0, 4)) : new Response(contents.subarray(4), { status: 206 })),
      { stallMs: 50 },
    );

    expect(gets).toHaveLength(2);
    expect(gets[1]?.headers).toEqual(expect.objectContaining({ Range: "bytes=4-" }));
    expect(new Uint8Array(fs.readFileSync(blobPath("model.safetensors")))).toEqual(contents);
    expect(progress.at(-1)).toBe(1);
  });

  test("gives up on a file that stalls without sending anything, rather than waiting forever", async () => {
    const attempt = downloadFrom({ "model.safetensors": contents }, () => hangingAfter(new Uint8Array(0)), { stallMs: 50 });
    await expect(attempt).rejects.toThrow("Download of model.safetensors stalled: no data for 0.05s, 5 times in a row");
    expect(fs.existsSync(blobPath("model.safetensors"))).toBe(false);
  });

  test("counts the bytes already on disk when a download resumes", async () => {
    fs.writeFileSync(incompletePath("model.safetensors"), contents.subarray(0, 4));

    const { gets, progress } = await downloadFrom({ "model.safetensors": contents }, () =>
      new Response(contents.subarray(4), { status: 206 }),
    );

    expect(gets[0]?.headers).toEqual(expect.objectContaining({ Range: "bytes=4-" }));
    expect(new Uint8Array(fs.readFileSync(blobPath("model.safetensors")))).toEqual(contents);
    expect(progress.at(-1)).toBe(1);
  });
  test("takes a file from the source tried first, without asking HuggingFace for it", async () => {
    const source: FileSource = { name: "elsewhere", fetch: async ({ incompletePath }) => {
      fs.writeFileSync(incompletePath, contents);
      return true;
    } };
    const { gets, progress } = await downloadFrom({ "model.safetensors": contents }, undefined, { source });

    expect(gets).toHaveLength(0);
    expect(new Uint8Array(fs.readFileSync(blobPath("model.safetensors")))).toEqual(contents);
    expect(progress.at(-1)).toBe(1);
  });

  test("downloads a file from HuggingFace when the source tried first declines it", async () => {
    const { gets } = await downloadFrom({ "model.safetensors": contents }, undefined, { source: { name: "elsewhere", fetch: async () => false } });

    expect(gets).toHaveLength(1);
    expect(new Uint8Array(fs.readFileSync(blobPath("model.safetensors")))).toEqual(contents);
  });
});

describe("largestWeightFileBytes", () => {
  const model = "test/sharded";
  const commitHash = "b".repeat(40);
  const snapshotDir = path.join(testCacheDir, "hub", `models--${model.replace("/", "--")}`, "snapshots", commitHash);

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  test("takes the largest weight file the repository lists, whatever is cached so far", async () => {
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, "model-00001.safetensors"), new Uint8Array(10));
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      const url = String(input);
      if (url.endsWith(`/api/models/${model}`)) {
        return Response.json({ sha: commitHash });
      }
      return Response.json([
        { type: "file", path: "model-00001.safetensors", size: 10 },
        { type: "file", path: "model-00002.safetensors", size: 0, lfs: { size: 70 } },
        { type: "file", path: "tokenizer.json", size: 900 },
      ]);
    }) as typeof fetch);
    try {
      expect(await largestWeightFileBytes(model)).toBe(70);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("falls back to the cached snapshot when the repository cannot be reached", async () => {
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.mkdirSync(path.join(testCacheDir, "hub", `models--${model.replace("/", "--")}`, "refs"), { recursive: true });
    fs.writeFileSync(path.join(testCacheDir, "hub", `models--${model.replace("/", "--")}`, "refs", "main"), commitHash);
    fs.writeFileSync(path.join(snapshotDir, "model-00001.safetensors"), new Uint8Array(30));
    fs.writeFileSync(path.join(snapshotDir, "tokenizer.json"), new Uint8Array(90));
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    try {
      expect(await largestWeightFileBytes(model)).toBe(30);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
