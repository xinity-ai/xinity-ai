import { describe, it, expect, beforeEach, afterAll, afterEach, mock } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Mocks: must be registered before the dynamic import below
// ---------------------------------------------------------------------------

mock.module("./env", () => ({
  env: {
    MODEL_INFO_FILE: "/tmp/test-models.yaml",
    PORT: 8090,
    REFRESH_INTERVAL_MS: 300_000,
    MAX_INCLUDE_DEPTH: 10,
    LOG_LEVEL: "silent",
    LOG_DIR: undefined,
  },
}));

mock.module("./logger", () => ({
  rootLogger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

// Dynamic import so mocks are active when the module (and its transitive deps) load
const {
  configure,
  refresh,
  get,
  getByProviderModel,
  resolve,
  resolveBatch,
  getAll,
  getByFamily,
  getMergedData,
  getCatalogHealth,
  stopAutoRefresh,
} = await import("./server-catalog");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `catalog-test-${Date.now()}`);

function makeModelYaml(models: Record<string, object>, includes?: string[]): string {
  const obj: Record<string, unknown> = { models };
  if (includes) obj.includes = includes;
  return Bun.YAML.stringify(obj);
}

async function writeYamlFile(content: string, index: number): Promise<string> {
  const path = join(testDir, `models-${index}.yaml`);
  await Bun.write(path, content);
  return path;
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
      const path = await writeYamlFile(yaml, fileIndex++);
      configure(10, path);
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

    it("looks up by provider model name", () => {
      const m = getByProviderModel("org/llama-vllm");
      expect(m).toBeDefined();
      expect(m!.publicSpecifier).toBe("llama-3.3-70b");
    });

    it("returns undefined for unknown provider model", () => {
      expect(getByProviderModel("unknown/model")).toBeUndefined();
    });

    it("resolve() tries specifier first, then falls back to provider model", () => {
      expect(resolve("llama-3.3-70b")?.publicSpecifier).toBe("llama-3.3-70b");
      expect(resolve("nomic-embed")?.publicSpecifier).toBe("nomic-embed-text");
      expect(resolve("nothing")).toBeUndefined();
    });

    it("resolveBatch() returns map with nulls for missing specifiers", () => {
      const result = resolveBatch(["llama-3.3-70b", "missing", "nomic-embed"]);
      expect(result["llama-3.3-70b"]).toBeDefined();
      expect(result["llama-3.3-70b"]!.publicSpecifier).toBe("llama-3.3-70b");
      expect(result["missing"]).toBeNull();
      expect(result["nomic-embed"]?.publicSpecifier).toBe("nomic-embed-text");
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
      const path = await writeYamlFile(yaml, fileIndex++);
      configure(10, path);
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
      const path = await writeYamlFile(localYaml, fileIndex++);
      configure(10, path);
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
      const path = await writeYamlFile(localYaml, fileIndex++);
      configure(10, path);
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
      const path = await writeYamlFile(localYaml, fileIndex++);
      configure(2, path);
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
      const path = await writeYamlFile(localYaml, fileIndex++);
      configure(10, path);
      await refresh();

      expect(get("local-model")).toBeDefined();
    });
  });

  describe("validation", () => {
    it("throws on invalid YAML that fails parsing", async () => {
      const path = await writeYamlFile("not: valid: model: file:", fileIndex++);
      configure(10, path);
      await expect(refresh()).rejects.toThrow();
    });

    it("throws when YAML is valid but fails schema validation", async () => {
      const path = await writeYamlFile("someKey: someValue\n", fileIndex++);
      configure(10, path);
      await expect(refresh()).rejects.toThrow("Model file validation failed");
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

    it("skips invalid files and continues loading valid ones", async () => {
      const dirPath = join(testDir, `dir-${fileIndex++}`);
      await Bun.write(join(dirPath, "a-bad.yaml"), "someKey: someValue\n");
      await Bun.write(join(dirPath, "b-good.yaml"), makeModelYaml({ "good-model": baseModel }));

      configure(10, undefined, dirPath);
      await refresh();

      expect(get("good-model")).toBeDefined();
      expect(getAll()).toHaveLength(1);
    });

    it("combines main file and directory models", async () => {
      const mainYaml = makeModelYaml({ "main-model": baseModel });
      const mainPath = await writeYamlFile(mainYaml, fileIndex++);

      const dirPath = join(testDir, `dir-${fileIndex++}`);
      await Bun.write(join(dirPath, "extra.yaml"), makeModelYaml({ "dir-model": embeddingModel }));

      configure(10, mainPath, dirPath);
      await refresh();

      expect(get("main-model")).toBeDefined();
      expect(get("dir-model")).toBeDefined();
      expect(getAll()).toHaveLength(2);
    });

    it("gracefully handles missing directory", async () => {
      const mainYaml = makeModelYaml({ "main-model": baseModel });
      const mainPath = await writeYamlFile(mainYaml, fileIndex++);

      configure(10, mainPath, "/nonexistent/dir/path");
      await refresh();

      expect(get("main-model")).toBeDefined();
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
      const path = await writeYamlFile(localYaml, fileIndex++);
      configure(10, path);
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
      const path = await writeYamlFile(yaml, fileIndex++);
      configure(10, path);
      await refresh();

      expect(get("tracked-model")!._source).toBe(path);
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
      const path = await writeYamlFile(localYaml, fileIndex++);
      configure(10, path);
      await refresh();

      expect(get("remote-tracked")!._source).toBe(includeUrl);
      expect(get("local-tracked")!._source).toBe(path);

      includeServer.stop(true);
    });
  });

  describe("catalog health", () => {
    it("reports model count and refresh time after successful load", async () => {
      const yaml = makeModelYaml({ "health-model": baseModel });
      const path = await writeYamlFile(yaml, fileIndex++);
      configure(10, path);
      await refresh();

      const health = getCatalogHealth();
      expect(health.modelCount).toBe(1);
      expect(health.lastRefreshAt).toBeTruthy();
      expect(health.lastRefreshError).toBeNull();
    });

    it("records error message on failed refresh", async () => {
      const path = await writeYamlFile("someKey: someValue\n", fileIndex++);
      configure(10, path);

      try { await refresh(); } catch {}

      const health = getCatalogHealth();
      expect(health.lastRefreshError).toContain("Model file validation failed");
    });
  });
});
