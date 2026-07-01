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
  maxContextLength: 131072,

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
  maxContextLength: 131072,

  url: "https://example.com",
  entryVersion: "0.1.0",
  type: "embedding",
  family: "nomic",
  providers: { ollama: "nomic-embed-text" },
};

// Declares an entryVersion far beyond any real release, so every running
// instance is too old to use it and must filter it out.
const futureModel: ModelWithSpecifier = {
  publicSpecifier: "future-model",
  _source: "test",
  name: "Future Model",
  description: "Requires a newer xinity than we run",
  weight: 10,
  minKvCache: 2,
  maxContextLength: 131072,
  url: "https://example.com",
  entryVersion: "999.0.0",
  type: "chat",
  family: "llama",
  providers: { vllm: "org/future" },
};

// Version-compatible but structurally invalid (`weight` is not a number), so it
// must fail content validation and be dropped without poisoning the listing.
const malformedModel = {
  publicSpecifier: "malformed-model",
  _source: "test",
  name: "Malformed Model",
  description: "Invalid content",
  weight: "heavy",
  minKvCache: 1,
  url: "https://example.com",
  entryVersion: "0.1.0",
  providers: {},
} as unknown as ModelWithSpecifier;

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
        if (url.pathname === "/api/v1/models/future-model") {
          return Response.json(futureModel);
        }
        if (url.pathname === "/api/v1/models/malformed-model") {
          return Response.json(malformedModel);
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
          // `family=mixed` returns a list also containing an incompatible and a
          // malformed model, so consumers can assert both get filtered out.
          const models = url.searchParams.get("family") === "mixed"
            ? [testModel, futureModel, malformedModel, embedModel]
            : [testModel, embedModel];
          return Response.json({ models, total: models.length, page: 1, pageSize: 20 });
        }

        // POST /api/v1/models/resolve
        if (url.pathname === "/api/v1/models/resolve") {
          const { specifiers } = JSON.parse(entry.body!);
          const result: Record<string, ModelWithSpecifier | null> = {};
          for (const s of specifiers) {
            if (s === "llama-3.3-70b") result[s] = testModel;
            else if (s === "nomic-embed") result[s] = embedModel;
            else if (s === "future-model") result[s] = futureModel;
            else if (s === "malformed-model") result[s] = malformedModel;
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

  describe("entryVersion gating and content validation", () => {
    it("treats a model requiring a newer xinity as not found", async () => {
      const client = makeClient();
      const model = await client.fetchModel({ kind: "canonical", specifier: "future-model" });
      expect(model).toBeUndefined();
    });

    it("does not cache a gated model, so it reappears once supported", async () => {
      const client = makeClient();
      await client.fetchModel({ kind: "canonical", specifier: "future-model" });
      await client.fetchModel({ kind: "canonical", specifier: "future-model" });
      // Both calls hit the server: a not_found result is never cached.
      expect(requestLog).toHaveLength(2);
    });

    it("treats a model with invalid content as not found", async () => {
      const client = makeClient();
      const model = await client.fetchModel({ kind: "canonical", specifier: "malformed-model" });
      expect(model).toBeUndefined();
    });

    it("drops incompatible and malformed models from a listing, keeping the rest", async () => {
      const client = makeClient();
      const result = await client.fetchModels({ family: "mixed" });
      const specifiers = result.models.map((m) => m.publicSpecifier);
      expect(specifiers).toEqual(["llama-3.3-70b", "nomic-embed"]);
      expect(specifiers).not.toContain("future-model");
      expect(specifiers).not.toContain("malformed-model");
    });

    it("maps gated and malformed batch entries to null", async () => {
      const client = makeClient();
      const result = await client.fetchModelsBatch(["llama-3.3-70b", "future-model", "malformed-model"]);
      expect(result["llama-3.3-70b"]).toBeDefined();
      expect(result["future-model"]).toBeNull();
      expect(result["malformed-model"]).toBeNull();
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
