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
  registeredAt: "2025-01-01",
  url: "https://example.com",
  entryVersion: "0.1.0",
  providers: { vllm: "org/llama-vllm", ollama: "llama-ollama" },
};

const embeddingModel = {
  name: "Test Embed",
  description: "An embedding model",
  weight: 5,
  minKvCache: 1,
  registeredAt: "2025-01-01",
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
      configure(path);
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
      configure(path);
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
        registeredAt: "2025-02-01",
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
      configure(path);
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
      configure(path);
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
      configure(path, 2);
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
      configure(path);
      await refresh();

      expect(get("local-model")).toBeDefined();
    });
  });

  describe("validation", () => {
    it("throws on invalid YAML that fails parsing", async () => {
      const path = await writeYamlFile("not: valid: model: file:", fileIndex++);
      configure(path);
      await expect(refresh()).rejects.toThrow();
    });

    it("throws when YAML is valid but fails schema validation", async () => {
      const path = await writeYamlFile("someKey: someValue\n", fileIndex++);
      configure(path);
      await expect(refresh()).rejects.toThrow("Failed to validate model file");
    });
  });
});
