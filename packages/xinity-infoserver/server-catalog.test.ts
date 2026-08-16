import { describe, it, expect, beforeEach, afterAll, afterEach, mock } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Mocks: must be registered before the dynamic import below
// ---------------------------------------------------------------------------

mock.module("./env", () => ({
  env: {
    MODEL_INFO_DIR: "/tmp/test-models",
    PORT: 8090,
    REFRESH_INTERVAL_MS: 300_000,
    MAX_INCLUDE_DEPTH: 10,
    LOG_LEVEL: "silent",
    LOG_DIR: undefined,
  },
}));

const logWarn = mock((_fields: unknown, _msg?: string) => {});

mock.module("./logger", () => ({
  rootLogger: {
    child: () => ({
      info: () => {},
      warn: logWarn,
      error: () => {},
      debug: () => {},
    }),
  },
}));

// Dynamic import so mocks are active when the module (and its transitive deps) load
const {
  configure,
  refresh,
  legacyCatalog,
  modelCatalog,
  getCatalogHealth,
  stopAutoRefresh,
} = await import("./server-catalog");

// The fixtures below are v1-shaped, so they load through the legacy directory.
const { get, resolveBatch, getAll, getByFamily, getMergedData, getSerializedCatalog } = legacyCatalog;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `catalog-test-${Date.now()}`);

function makeModelYaml(models: Record<string, object>, includes?: string[]): string {
  const obj: Record<string, unknown> = { models };
  if (includes) {
    obj.includes = includes;
  }
  return Bun.YAML.stringify(obj);
}

async function writeYamlInOwnDir(content: string, index: number): Promise<{ dirPath: string; filePath: string }> {
  const dirPath = join(testDir, `models-${index}`);
  const filePath = join(dirPath, "models.yaml");
  await Bun.write(filePath, content);
  return { dirPath, filePath };
}

const baseModel = {
  name: "Test Llama",
  description: "A test model",
  weight: 10,
  minKvCache: 2,

  url: "https://example.com",
  entryVersion: "0.1.0",
  providers: { vllm: "org/llama-vllm", ollama: "llama-ollama" },
};

const embeddingModel = {
  name: "Test Embed",
  description: "An embedding model",
  weight: 5,
  minKvCache: 1,

  url: "https://example.com",
  entryVersion: "0.1.0",
  type: "embedding",
  family: "nomic",
  providers: { ollama: "nomic-embed" },
};

const v2Model = {
  name: "Test Llama",
  description: "A test model",
  url: "https://example.com",
  license: "apache-2.0",
  createdAt: "2026-01-15",
  registeredAt: "2026-02-01",
  engine: "vllm",
  engineSpecifier: "org/llama-vllm",
  sizing: { weightGb: 10, minKvCacheGb: 2, maxContextLength: 131072 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterAll(() => stopAutoRefresh());

describe("server-catalog", () => {
  let fileIndex = 0;

  describe("refresh and query", () => {
    beforeEach(async () => {
      const yaml = makeModelYaml({
        "llama-3.3-70b": baseModel,
        "nomic-embed-text": embeddingModel,
      });
      const { dirPath } = await writeYamlInOwnDir(yaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();
    });

    it("indexes models from YAML and retrieves by specifier", () => {
      const m = get("llama-3.3-70b");
      expect(m).toBeDefined();
      expect(m!.publicSpecifier).toBe("llama-3.3-70b");
      expect(m!.name).toBe("Test Llama");
    });

    it("returns undefined for unknown specifier", () => {
      expect(get("nonexistent")).toBeUndefined();
    });

    it("resolveBatch() returns map with nulls for missing specifiers", () => {
      const result = resolveBatch(["llama-3.3-70b", "missing", "nomic-embed-text"]);
      expect(result["llama-3.3-70b"]).toBeDefined();
      expect(result["llama-3.3-70b"]!.publicSpecifier).toBe("llama-3.3-70b");
      expect(result["missing"]).toBeNull();
      expect(result["nomic-embed-text"]?.publicSpecifier).toBe("nomic-embed-text");
    });

    it("getAll() returns all indexed models", () => {
      const all = getAll();
      expect(all).toHaveLength(2);
      const specifiers = all.map(m => m.publicSpecifier).sort();
      expect(specifiers).toEqual(["llama-3.3-70b", "nomic-embed-text"]);
    });

    it("getByFamily() filters by family, defaults to 'unknown'", () => {
      const nomic = getByFamily("nomic");
      expect(nomic).toHaveLength(1);
      expect(nomic[0]!.publicSpecifier).toBe("nomic-embed-text");

      const unknown = getByFamily("unknown");
      expect(unknown).toHaveLength(1);
      expect(unknown[0]!.publicSpecifier).toBe("llama-3.3-70b");

      expect(getByFamily("nonexistent")).toHaveLength(0);
    });

    it("getMergedData() returns all models keyed by specifier", () => {
      const data = getMergedData();
      expect(Object.keys(data.models)).toHaveLength(2);
      expect(data.models["llama-3.3-70b"]).toBeDefined();
      expect(data.models["nomic-embed-text"]).toBeDefined();
    });
  });

  describe("duplicate handling", () => {
    it("later entry overwrites earlier with same specifier", async () => {
      const yaml = makeModelYaml({ "llama-3.3-70b": baseModel });
      const { dirPath } = await writeYamlInOwnDir(yaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();
      expect(get("llama-3.3-70b")?.name).toBe("Test Llama");
    });
  });

  describe("includes", () => {
    let includeServer: ReturnType<typeof Bun.serve>;

    afterEach(() => {
      includeServer?.stop(true);
    });

    it("resolves remote includes and merges models", async () => {
      const remoteModel = {
        name: "Remote Model",
        description: "From include",
        weight: 8,
        minKvCache: 1,
        url: "https://example.com",
        entryVersion: "0.1.0",
        providers: { vllm: "org/remote-vllm" },
      };
      const remoteYaml = makeModelYaml({ "remote-model": remoteModel });

      includeServer = Bun.serve({
        port: 0,
        fetch: () => new Response(remoteYaml, { headers: { "Content-Type": "text/yaml" } }),
      });

      const localYaml = makeModelYaml(
        { "local-model": baseModel },
        [`http://localhost:${includeServer.port}/models.yaml`],
      );
      const { dirPath } = await writeYamlInOwnDir(localYaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();

      expect(get("local-model")).toBeDefined();
      expect(get("remote-model")).toBeDefined();
      expect(get("remote-model")!.name).toBe("Remote Model");
    });

    it("detects cycles and skips already-visited URLs", async () => {
      includeServer = Bun.serve({
        port: 0,
        fetch() {
          const selfUrl = `http://localhost:${includeServer.port}/self.yaml`;
          const yaml = makeModelYaml(
            { "cycle-model": { ...baseModel, name: "Cycle" } },
            [selfUrl],
          );
          return new Response(yaml, { headers: { "Content-Type": "text/yaml" } });
        },
      });

      const localYaml = makeModelYaml(
        { "local-model": baseModel },
        [`http://localhost:${includeServer.port}/self.yaml`],
      );
      const { dirPath } = await writeYamlInOwnDir(localYaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();

      expect(get("local-model")).toBeDefined();
      expect(get("cycle-model")).toBeDefined();
    });

    it("stops at max include depth", async () => {
      let requestCount = 0;
      includeServer = Bun.serve({
        port: 0,
        fetch() {
          requestCount++;
          const nextUrl = `http://localhost:${includeServer.port}/level${requestCount}.yaml`;
          const yaml = makeModelYaml(
            { [`depth-${requestCount}`]: { ...baseModel, name: `Depth ${requestCount}` } },
            [nextUrl],
          );
          return new Response(yaml, { headers: { "Content-Type": "text/yaml" } });
        },
      });

      const localYaml = makeModelYaml(
        { "root-model": baseModel },
        [`http://localhost:${includeServer.port}/start.yaml`],
      );
      const { dirPath } = await writeYamlInOwnDir(localYaml, fileIndex++);
      configure(2, undefined, dirPath);
      await refresh();

      expect(get("root-model")).toBeDefined();
      expect(requestCount).toBeLessThanOrEqual(2);
    });

    it("continues gracefully when include fetch fails", async () => {
      includeServer = Bun.serve({
        port: 0,
        fetch: () => new Response("Server Error", { status: 500 }),
      });

      const localYaml = makeModelYaml(
        { "local-model": baseModel },
        [`http://localhost:${includeServer.port}/bad.yaml`],
      );
      const { dirPath } = await writeYamlInOwnDir(localYaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();

      expect(get("local-model")).toBeDefined();
    });
  });

  describe("include fetch timeout", () => {
    const realFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it("passes an abort signal so an unresponsive host cannot stall the refresh", async () => {
      let receivedSignal: AbortSignal | undefined;
      globalThis.fetch = ((_url: string, init?: RequestInit) => {
        receivedSignal = init?.signal ?? undefined;
        return Promise.resolve(new Response(makeModelYaml({ "remote-model": baseModel })));
      }) as typeof fetch;

      const localYaml = makeModelYaml({ "local-model": baseModel }, ["http://unreachable.invalid/models.yaml"]);
      const { dirPath } = await writeYamlInOwnDir(localYaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();

      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(get("remote-model")).toBeDefined();
    });

    it("keeps local models when an include times out", async () => {
      globalThis.fetch = ((_url: string, _init?: RequestInit) =>
        Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))) as typeof fetch;

      const localYaml = makeModelYaml({ "local-model": baseModel }, ["http://unreachable.invalid/models.yaml"]);
      const { dirPath } = await writeYamlInOwnDir(localYaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();

      expect(get("local-model")).toBeDefined();
      expect(get("remote-model")).toBeUndefined();
      expect(getCatalogHealth().legacy!.lastRefreshError).toBeNull();
    });
  });

  describe("validation", () => {
    it("skips files with unparseable YAML and continues with the rest", async () => {
      const dirPath = join(testDir, `dir-${fileIndex++}`);
      await Bun.write(join(dirPath, "a-bad.yaml"), "not: valid: model: file:");
      await Bun.write(join(dirPath, "b-good.yaml"), makeModelYaml({ "good-model": baseModel }));
      configure(10, undefined, dirPath);
      await refresh();

      expect(get("good-model")).toBeDefined();
      expect(getAll()).toHaveLength(1);
    });

    it("skips files that fail schema validation and continues with the rest", async () => {
      const dirPath = join(testDir, `dir-${fileIndex++}`);
      await Bun.write(join(dirPath, "a-bad.yaml"), "someKey: someValue\n");
      await Bun.write(join(dirPath, "b-good.yaml"), makeModelYaml({ "good-model": baseModel }));
      configure(10, undefined, dirPath);
      await refresh();

      expect(get("good-model")).toBeDefined();
      expect(getAll()).toHaveLength(1);
    });
  });

  describe("directory loading", () => {
    it("loads models from a directory of YAML files", async () => {
      const dirPath = join(testDir, `dir-${fileIndex++}`);
      await Bun.write(join(dirPath, "a-models.yaml"), makeModelYaml({ "dir-model-a": baseModel }));
      await Bun.write(join(dirPath, "b-models.yaml"), makeModelYaml({ "dir-model-b": embeddingModel }));

      configure(10, undefined, dirPath);
      await refresh();

      expect(get("dir-model-a")).toBeDefined();
      expect(get("dir-model-b")).toBeDefined();
      expect(getAll()).toHaveLength(2);
    });

    it("ignores non-yaml files in the directory", async () => {
      const dirPath = join(testDir, `dir-${fileIndex++}`);
      await Bun.write(join(dirPath, "valid.yaml"), makeModelYaml({ "yaml-model": baseModel }));
      await Bun.write(join(dirPath, "readme.txt"), "not yaml");
      await Bun.write(join(dirPath, "config.json"), "{}");

      configure(10, undefined, dirPath);
      await refresh();

      expect(getAll()).toHaveLength(1);
      expect(get("yaml-model")).toBeDefined();
    });

    it("loads catalog as empty when the configured directory is missing", async () => {
      configure(10, undefined, "/nonexistent/dir/path");
      await refresh();

      expect(getAll()).toHaveLength(0);
    });
  });

  describe("precedence", () => {
    let includeServer: ReturnType<typeof Bun.serve>;

    afterEach(() => {
      includeServer?.stop(true);
    });

    it("local models are not overwritten by remote includes", async () => {
      const remoteModel = { ...baseModel, name: "Remote Version" };
      const remoteYaml = makeModelYaml({ "shared-model": remoteModel });

      includeServer = Bun.serve({
        port: 0,
        fetch: () => new Response(remoteYaml, { headers: { "Content-Type": "text/yaml" } }),
      });

      const localModel = { ...baseModel, name: "Local Version" };
      const localYaml = makeModelYaml(
        { "shared-model": localModel },
        [`http://localhost:${includeServer.port}/models.yaml`],
      );
      const { dirPath } = await writeYamlInOwnDir(localYaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();

      expect(get("shared-model")!.name).toBe("Local Version");
    });

    it("directory files are not overwritten by their own remote includes", async () => {
      const remoteModel = { ...baseModel, name: "Remote Override" };
      const remoteYaml = makeModelYaml({ "dir-local": remoteModel });

      includeServer = Bun.serve({
        port: 0,
        fetch: () => new Response(remoteYaml, { headers: { "Content-Type": "text/yaml" } }),
      });

      const dirModel = { ...baseModel, name: "Dir Local" };
      const dirPath = join(testDir, `dir-${fileIndex++}`);
      await Bun.write(
        join(dirPath, "models.yaml"),
        makeModelYaml({ "dir-local": dirModel }, [`http://localhost:${includeServer.port}/models.yaml`]),
      );

      configure(10, undefined, dirPath);
      await refresh();

      expect(get("dir-local")!.name).toBe("Dir Local");
    });
  });

  describe("_source tracking", () => {
    it("tracks source file path for locally loaded models", async () => {
      const yaml = makeModelYaml({ "tracked-model": baseModel });
      const { dirPath, filePath } = await writeYamlInOwnDir(yaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();

      expect(get("tracked-model")!._source).toBe(filePath);
    });

    it("tracks source URL for remotely included models", async () => {
      const remoteModel = { ...baseModel, name: "Remote Tracked" };
      const remoteYaml = makeModelYaml({ "remote-tracked": remoteModel });

      const includeServer = Bun.serve({
        port: 0,
        fetch: () => new Response(remoteYaml, { headers: { "Content-Type": "text/yaml" } }),
      });

      const includeUrl = `http://localhost:${includeServer.port}/models.yaml`;
      const localYaml = makeModelYaml({ "local-tracked": baseModel }, [includeUrl]);
      const { dirPath, filePath } = await writeYamlInOwnDir(localYaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();

      expect(get("remote-tracked")!._source).toBe(includeUrl);
      expect(get("local-tracked")!._source).toBe(filePath);

      includeServer.stop(true);
    });
  });

  describe("catalog health", () => {
    it("reports model count and refresh time after successful load", async () => {
      const yaml = makeModelYaml({ "health-model": baseModel });
      const { dirPath } = await writeYamlInOwnDir(yaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();

      const health = getCatalogHealth().legacy!;
      expect(health.modelCount).toBe(1);
      expect(health.lastRefreshAt).toBeTruthy();
      expect(health.lastRefreshError).toBeNull();
    });

    it("keeps lastRefreshError null when individual files fail (skip-and-continue)", async () => {
      const dirPath = join(testDir, `dir-${fileIndex++}`);
      await Bun.write(join(dirPath, "bad.yaml"), "someKey: someValue\n");
      configure(10, undefined, dirPath);

      await refresh();

      const health = getCatalogHealth().legacy!;
      expect(health.lastRefreshError).toBeNull();
      expect(health.modelCount).toBe(0);
    });
  });

  describe("serialized bodies", () => {
    it("returns the same body instance across calls, without re-serializing", async () => {
      const yaml = makeModelYaml({ "llama-3.3-70b": baseModel });
      const { dirPath } = await writeYamlInOwnDir(yaml, fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();

      expect(getSerializedCatalog()).toBe(getSerializedCatalog());
    });

    it("keeps the digest stable across a refresh that changes nothing", async () => {
      const yaml = makeModelYaml({ "llama-3.3-70b": baseModel });
      const { dirPath } = await writeYamlInOwnDir(yaml, fileIndex++);
      configure(10, undefined, dirPath);

      await refresh();
      const first = getSerializedCatalog().digest;
      await refresh();

      expect(getSerializedCatalog().digest).toBe(first);
    });

    it("changes the digest when a model changes", async () => {
      const { dirPath } = await writeYamlInOwnDir(makeModelYaml({ "llama-3.3-70b": baseModel }), fileIndex++);
      configure(10, undefined, dirPath);
      await refresh();
      const before = getSerializedCatalog().digest;

      await Bun.write(join(dirPath, "models.yaml"), makeModelYaml({
        "llama-3.3-70b": { ...baseModel, weight: 20 },
      }));
      await refresh();

      expect(getSerializedCatalog().digest).not.toBe(before);
    });

    it("ignores specifier ordering, so a reordered include keeps the digest", async () => {
      const ordered = await writeYamlInOwnDir(
        makeModelYaml({ "a-model": baseModel, "z-model": embeddingModel }),
        fileIndex++,
      );
      configure(10, undefined, ordered.dirPath);
      await refresh();
      const forward = getSerializedCatalog().digest;

      const reversed = await writeYamlInOwnDir(
        makeModelYaml({ "z-model": embeddingModel, "a-model": baseModel }),
        fileIndex++,
      );
      configure(10, undefined, reversed.dirPath);
      await refresh();

      expect(getSerializedCatalog().digest).toBe(forward);
    });
  });

  describe("format separation", () => {
    it("keeps the two catalogs independent", async () => {
      const current = await writeYamlInOwnDir(makeModelYaml({ "llama-vllm": v2Model }), fileIndex++);
      const legacy = await writeYamlInOwnDir(makeModelYaml({ "llama-3.3-70b": baseModel }), fileIndex++);
      configure(10, current.dirPath, legacy.dirPath);
      await refresh();

      expect(modelCatalog.get("llama-vllm")?.engine).toBe("vllm");
      expect(modelCatalog.get("llama-3.3-70b")).toBeUndefined();
      expect(legacyCatalog.get("llama-3.3-70b")).toBeDefined();
      expect(legacyCatalog.get("llama-vllm")).toBeUndefined();
    });

    it("refuses to start on a file it cannot use, rather than serving a smaller catalog", async () => {
      const { dirPath } = await writeYamlInOwnDir(makeModelYaml({ "llama-3.3-70b": baseModel }), fileIndex++);
      configure(10, dirPath, undefined);

      await expect(refresh()).rejects.toThrow(/is not a valid current-format model file/);
    });

    it("serves the entries of an include it understands and skips the rest", async () => {
      const ahead = Bun.serve({
        port: 0,
        fetch: () => new Response(makeModelYaml({
          "llama-vllm": v2Model,
          "llama-sglang": { ...v2Model, engine: "sglang" },
          "tagged-vllm": { ...v2Model, tags: ["tools", "reasoning"] },
        })),
      });

      try {
        const { dirPath } = await writeYamlInOwnDir(
          makeModelYaml({ "local-vllm": v2Model }, [`http://localhost:${ahead.port}/models.json`]),
          fileIndex++,
        );
        configure(10, dirPath, undefined);
        await refresh();

        expect(modelCatalog.get("local-vllm")).toBeDefined();
        expect(modelCatalog.get("llama-vllm")).toBeDefined();
        expect(modelCatalog.get("llama-sglang")).toBeUndefined();
        expect(modelCatalog.get("tagged-vllm")?.tags).toEqual(["tools"]);
      } finally {
        ahead.stop(true);
      }
    });

    it("still refuses a local file using vocabulary it does not know", async () => {
      const { dirPath } = await writeYamlInOwnDir(
        makeModelYaml({ "tagged-vllm": { ...v2Model, tags: ["tools", "reasoning"] } }),
        fileIndex++,
      );
      configure(10, dirPath, undefined);

      await expect(refresh()).rejects.toThrow(/is not a valid current-format model file/);
    });

    it("refuses to start when an include serves a document it cannot use", async () => {
      const wrongFormat = Bun.serve({
        port: 0,
        fetch: () => new Response(makeModelYaml({ "llama-3.3-70b": baseModel })),
      });

      try {
        const { dirPath } = await writeYamlInOwnDir(
          makeModelYaml({ "llama-vllm": v2Model }, [`http://localhost:${wrongFormat.port}/models.json`]),
          fileIndex++,
        );
        configure(10, dirPath, undefined);

        await expect(refresh()).rejects.toThrow(/is not a valid current-format model document/);
      } finally {
        wrongFormat.stop(true);
      }
    });

    it("strips system-managed vllm args instead of running with them", async () => {
      const { dirPath } = await writeYamlInOwnDir(makeModelYaml({
        "llama-vllm": { ...v2Model, engineArgs: ["--trust-remote-code", "--max-model-len", "4096"] },
      }), fileIndex++);
      configure(10, dirPath, undefined);
      await refresh();

      expect(modelCatalog.get("llama-vllm")?.engineArgs).toEqual(["--max-model-len", "4096"]);
    });
  });

  describe("kv cache consistency", () => {
    it("reports only the entry whose minKvCache contradicts its per-token cost", async () => {
      const { dirPath } = await writeYamlInOwnDir(makeModelYaml({
        "consistent-vllm": { ...v2Model, sizing: { ...v2Model.sizing, kvBytesPerToken: 16384 } },
        "windowed-vllm": { ...v2Model, sizing: { ...v2Model.sizing, kvBytesPerToken: 131072, attentionWindow: 16384 } },
        "mismatched-vllm": { ...v2Model, sizing: { ...v2Model.sizing, kvBytesPerToken: 131072 } },
      }), fileIndex++);
      configure(10, dirPath, undefined);
      logWarn.mockClear();
      await refresh();

      const reported = logWarn.mock.calls
        .filter(([, msg]) => msg?.includes("kvBytesPerToken"))
        .map(([fields]) => (fields as { specifier: string }).specifier);

      expect(reported).toEqual(["mismatched-vllm"]);
      expect(modelCatalog.get("mismatched-vllm")).toBeDefined();
    });
  });
});
