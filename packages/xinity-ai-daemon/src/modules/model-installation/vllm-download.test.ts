import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { mockDaemonConfig } from "../../mock-config";
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

const { downloadModel, hfUrl } = await import("./vllm-download");
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
  beforeEach(() => {
    fs.mkdirSync(testCacheDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  test("retries from scratch when an oversized .incomplete file gets a 416", async () => {
    const model = "test/model";
    const commitHash = "a".repeat(40);
    const etag = "test-etag";
    const contents = new TextEncoder().encode("0123456789");
    const staleContents = new TextEncoder().encode("01234567890");

    const repoDir = path.join(testCacheDir, "hub", `models--${model.replace("/", "--")}`);
    const blobsDir = path.join(repoDir, "blobs");
    fs.mkdirSync(blobsDir, { recursive: true });

    const incompletePath = path.join(blobsDir, `${etag}.incomplete`);
    const blobPath = path.join(blobsDir, etag);
    fs.writeFileSync(incompletePath, staleContents);

    let downloadAttempts = 0;
    const progress: number[] = [];
    const downloadHeaders: RequestInit["headers"][] = [];

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === `https://huggingface.co/api/models/${model}`) {
        return new Response(JSON.stringify({ sha: commitHash }), { status: 200 });
      }

      if (url === `https://huggingface.co/api/models/${model}/tree/${commitHash}?recursive=true`) {
        return new Response(
          JSON.stringify([{ type: "file", path: "model.safetensors", size: contents.byteLength }]),
          { status: 200 },
        );
      }

      if (url === `https://huggingface.co/${model}/resolve/${commitHash}/model.safetensors`) {
        if (method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { etag: `"${etag}"` },
          });
        }

        downloadAttempts++;
        downloadHeaders.push(init?.headers ?? {});

        if (downloadAttempts === 1) {
          return new Response(null, { status: 416 });
        }

        return new Response(contents, { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch);

    try {
      await downloadModel(model, async (value) => {
        progress.push(value);
      });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(downloadAttempts).toBe(2);
    expect(downloadHeaders[0]).toEqual(
      expect.objectContaining({ Range: `bytes=${staleContents.byteLength}-` }),
    );
    expect(downloadHeaders[1]).not.toEqual(
      expect.objectContaining({ Range: expect.any(String) }),
    );
    expect(progress.at(-1)).toBe(1);
    expect(fs.existsSync(incompletePath)).toBe(false);
    expect(new Uint8Array(fs.readFileSync(blobPath))).toEqual(contents);


  });
});
