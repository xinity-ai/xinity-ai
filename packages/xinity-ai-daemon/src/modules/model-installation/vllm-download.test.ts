import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock env before importing module under test
const testCacheDir = path.join(os.tmpdir(), `hf-download-test-${Date.now()}`);

mock.module("../../env", () => ({
  env: {
    VLLM_HF_CACHE_DIR: testCacheDir,
    VLLM_HF_TOKEN: undefined,
  },
}));

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

const { downloadModel } = await import("./vllm-download");

// ---------------------------------------------------------------------------
// These tests hit the real HuggingFace API. They use a tiny public model
// to keep download times minimal. Skipped if SKIP_NETWORK_TESTS is set.
// ---------------------------------------------------------------------------

const TINY_MODEL = "hf-internal-testing/tiny-random-gpt2";

function skipIfNoNetwork() {
  if (process.env.SKIP_NETWORK_TESTS) {
    return true;
  }
  return false;
}

describe("downloadModel (integration, real HF API)", () => {
  beforeEach(() => {
    fs.mkdirSync(testCacheDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  test("downloads a tiny model and reports progress", async () => {
    if (skipIfNoNetwork()) return;

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
    if (skipIfNoNetwork()) return;

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
    if (skipIfNoNetwork()) return;

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
