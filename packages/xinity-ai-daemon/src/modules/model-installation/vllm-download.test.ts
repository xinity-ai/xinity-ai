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
      });
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

  test("counts the bytes already on disk when a download resumes", async () => {
    fs.writeFileSync(incompletePath("model.safetensors"), contents.subarray(0, 4));

    const { gets, progress } = await downloadFrom({ "model.safetensors": contents }, () =>
      new Response(contents.subarray(4), { status: 206 }),
    );

    expect(gets[0]?.headers).toEqual(expect.objectContaining({ Range: "bytes=4-" }));
    expect(new Uint8Array(fs.readFileSync(blobPath("model.safetensors")))).toEqual(contents);
    expect(progress.at(-1)).toBe(1);
  });
});
