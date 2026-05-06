import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createInfoserverClient } from "./client";
import type { ModelWithSpecifier } from "./definitions/model-definition";

const testModel: ModelWithSpecifier = {
  publicSpecifier: "llama-3.3-70b",
  _source: "test",
  name: "Test Llama",
  description: "A test model",
  weight: 10,
  minKvCache: 2,

  url: "https://example.com",
  entryVersion: "0.1.0",
  type: "chat",
  family: "llama",
  tags: ["tools", "vision"],
  providers: { vllm: "org/llama-vllm", ollama: "llama-ollama" },
};

const embedModel: ModelWithSpecifier = {
  publicSpecifier: "nomic-embed",
  _source: "test",
  name: "Nomic Embed",
  description: "An embedding model",
  weight: 5,
  minKvCache: 1,

  url: "https://example.com",
  entryVersion: "0.1.0",
  type: "embedding",
  family: "nomic",
  providers: { ollama: "nomic-embed-text" },
};

describe("createInfoserverClient", () => {
  let server: ReturnType<typeof Bun.serve>;
  let requestLog: { method: string; url: string; body?: string }[];

  beforeEach(() => {
    requestLog = [];
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const entry: { method: string; url: string; body?: string } = {
          method: req.method,
          url: url.pathname + url.search,
        };
        if (req.method === "POST") {
          entry.body = await req.text();
        }
        requestLog.push(entry);

        // GET /api/v1/models/:specifier
        if (url.pathname === "/api/v1/models/llama-3.3-70b") {
          return Response.json(testModel);
        }
        if (url.pathname === "/api/v1/models/nomic-embed") {
          return Response.json(embedModel);
        }
        if (url.pathname === "/api/v1/models/not-found") {
          return new Response("Not Found", { status: 404 });
        }
        if (url.pathname === "/api/v1/models/server-error") {
          return new Response("Internal Server Error", { status: 500 });
        }

        // GET /api/v1/models/family/:family
        if (url.pathname === "/api/v1/models/family/llama") {
          return Response.json([testModel]);
        }

        // GET /api/v1/models
        if (url.pathname === "/api/v1/models") {
          return Response.json({
            models: [testModel, embedModel],
            total: 2,
            page: 1,
            pageSize: 20,
          });
        }

        // POST /api/v1/models/resolve
        if (url.pathname === "/api/v1/models/resolve") {
          const { specifiers } = JSON.parse(entry.body!);
          const result: Record<string, ModelWithSpecifier | null> = {};
          for (const s of specifiers) {
            if (s === "llama-3.3-70b") result[s] = testModel;
            else if (s === "nomic-embed") result[s] = embedModel;
            else result[s] = null;
          }
          return Response.json(result);
        }

        return new Response("Not Found", { status: 404 });
      },
    });
  });

  afterEach(() => {
    server.stop(true);
  });

  function makeClient(cacheTtlMs = 60_000) {
    return createInfoserverClient({
      baseUrl: `http://localhost:${server.port}`,
      cacheTtlMs,
    });
  }

  describe("fetchModel", () => {
    it("fetches a model from the server on cache miss", async () => {
      const client = makeClient();
      const model = await client.fetchModel({ kind: "canonical", specifier: "llama-3.3-70b" });
      expect(model).toBeDefined();
      expect(model!.publicSpecifier).toBe("llama-3.3-70b");
      expect(requestLog).toHaveLength(1);
    });

    it("returns cached data on subsequent calls within TTL", async () => {
      const client = makeClient();
      await client.fetchModel({ kind: "canonical", specifier: "llama-3.3-70b" });
      await client.fetchModel({ kind: "canonical", specifier: "llama-3.3-70b" });
      await client.fetchModel({ kind: "canonical", specifier: "llama-3.3-70b" });
      // Only one server request
      expect(requestLog).toHaveLength(1);
    });

    it("re-fetches after cache TTL expires", async () => {
      const nowSpy = spyOn(Date, "now");
      const start = Date.now();
      nowSpy.mockReturnValue(start);

      const client = makeClient(1000); // 1 second TTL
      await client.fetchModel({ kind: "canonical", specifier: "llama-3.3-70b" });
      expect(requestLog).toHaveLength(1);

      // Advance past TTL
      nowSpy.mockReturnValue(start + 1500);
      await client.fetchModel({ kind: "canonical", specifier: "llama-3.3-70b" });
      expect(requestLog).toHaveLength(2);

      nowSpy.mockRestore();
    });

    it("returns undefined for 404", async () => {
      const client = makeClient();
      const model = await client.fetchModel({ kind: "canonical", specifier: "not-found" });
      expect(model).toBeUndefined();
    });

    it("throws on server error", async () => {
      const client = makeClient();
      await expect(client.fetchModel({ kind: "canonical", specifier: "server-error" })).rejects.toThrow('Infoserver unavailable for canonical "server-error": HTTP 500');
    });

    it("sends `lookup=canonical` for canonical lookups", async () => {
      const client = makeClient();
      await client.fetchModel({ kind: "canonical", specifier: "llama-3.3-70b" });
      expect(requestLog[0]!.url).toContain("lookup=canonical");
    });

    it("sends `lookup=provider` for legacy lookups", async () => {
      const client = makeClient();
      await client.fetchModel({ kind: "legacy", providerModel: "llama-3.3-70b" });
      expect(requestLog[0]!.url).toContain("lookup=provider");
    });

    it("caches canonical and legacy lookups under separate keys", async () => {
      const client = makeClient();
      await client.fetchModel({ kind: "canonical", specifier: "llama-3.3-70b" });
      await client.fetchModel({ kind: "legacy", providerModel: "llama-3.3-70b" });
      expect(requestLog).toHaveLength(2);
    });
  });

  describe("fetchModelsBatch", () => {
    it("sends POST with specifiers and returns resolved map", async () => {
      const client = makeClient();
      const result = await client.fetchModelsBatch(["llama-3.3-70b", "missing"]);
      expect(result["llama-3.3-70b"]).toBeDefined();
      expect(result["missing"]).toBeNull();
      expect(requestLog[0]!.method).toBe("POST");
    });

    it("caches by sorted specifiers", async () => {
      const client = makeClient();
      await client.fetchModelsBatch(["b", "a"]);
      await client.fetchModelsBatch(["a", "b"]); // Same sorted key
      expect(requestLog).toHaveLength(1);
    });
  });

  describe("fetchModels", () => {
    it("fetches paginated models list", async () => {
      const client = makeClient();
      const result = await client.fetchModels();
      expect(result.models).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("passes query parameters", async () => {
      const client = makeClient();
      await client.fetchModels({ page: 2, pageSize: 10, type: "chat", family: "llama" });
      expect(requestLog[0]!.url).toContain("page=2");
      expect(requestLog[0]!.url).toContain("pageSize=10");
      expect(requestLog[0]!.url).toContain("type=chat");
      expect(requestLog[0]!.url).toContain("family=llama");
    });
  });

  describe("hasTag", () => {
    it("returns true when model has the tag", async () => {
      const client = makeClient();
      expect(await client.hasTag({ kind: "canonical", specifier: "llama-3.3-70b" }, "tools")).toBe(true);
    });

    it("returns false when model does not have the tag", async () => {
      const client = makeClient();
      expect(await client.hasTag({ kind: "canonical", specifier: "llama-3.3-70b" }, "custom_code")).toBe(false);
    });
  });

  describe("resolveDriverArgs", () => {
    it("returns empty array when model has no providerArgs", async () => {
      const client = makeClient();
      const args = await client.resolveDriverArgs({ kind: "canonical", specifier: "llama-3.3-70b" });
      expect(args).toEqual([]);
    });
  });
});
