import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createCatalogClient, createInfoserverClient } from "./client";
import type { LegacyModelWithSpecifier } from "./definitions/model-definition";

const testModel: LegacyModelWithSpecifier = {
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

const embedModel: LegacyModelWithSpecifier = {
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
const futureModel: LegacyModelWithSpecifier = {
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
} as unknown as LegacyModelWithSpecifier;

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
          const result: Record<string, LegacyModelWithSpecifier | null> = {};
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
      const model = await client.fetchModel("llama-3.3-70b");
      expect(model).toBeDefined();
      expect(model!.publicSpecifier).toBe("llama-3.3-70b");
      expect(requestLog).toHaveLength(1);
    });

    it("returns cached data on subsequent calls within TTL", async () => {
      const client = makeClient();
      await client.fetchModel("llama-3.3-70b");
      await client.fetchModel("llama-3.3-70b");
      await client.fetchModel("llama-3.3-70b");
      // Only one server request
      expect(requestLog).toHaveLength(1);
    });

    it("re-fetches after cache TTL expires", async () => {
      const nowSpy = spyOn(Date, "now");
      const start = Date.now();
      nowSpy.mockReturnValue(start);

      const client = makeClient(1000); // 1 second TTL
      await client.fetchModel("llama-3.3-70b");
      expect(requestLog).toHaveLength(1);

      // Advance past TTL
      nowSpy.mockReturnValue(start + 1500);
      await client.fetchModel("llama-3.3-70b");
      expect(requestLog).toHaveLength(2);

      nowSpy.mockRestore();
    });

    it("returns undefined for 404", async () => {
      const client = makeClient();
      const model = await client.fetchModel("not-found");
      expect(model).toBeUndefined();
    });

    it("throws on server error", async () => {
      const client = makeClient();
      await expect(client.fetchModel("server-error")).rejects.toThrow('Infoserver unavailable for "server-error": HTTP 500');
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
      const model = await client.fetchModel("future-model");
      expect(model).toBeUndefined();
    });

    it("does not cache a gated model, so it reappears once supported", async () => {
      const client = makeClient();
      await client.fetchModel("future-model");
      await client.fetchModel("future-model");
      // Both calls hit the server: a not_found result is never cached.
      expect(requestLog).toHaveLength(2);
    });

    it("treats a model with invalid content as not found", async () => {
      const client = makeClient();
      const model = await client.fetchModel("malformed-model");
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
      expect(await client.hasTag("llama-3.3-70b", "tools")).toBe(true);
    });

    it("returns false when model does not have the tag", async () => {
      const client = makeClient();
      expect(await client.hasTag("llama-3.3-70b", "custom_code")).toBe(false);
    });
  });

  describe("resolveDriverArgs", () => {
    it("returns empty array when model has no providerArgs", async () => {
      const client = makeClient();
      const args = await client.resolveDriverArgs("llama-3.3-70b");
      expect(args).toEqual([]);
    });
  });
});

describe("createCatalogClient", () => {
  const v2Model = {
    name: "Test Llama",
    description: "A test model",
    url: "https://example.com",
    engine: "vllm",
    engineSpecifier: "org/llama-vllm",
    weight: 10,
    minKvCache: 2,
    maxContextLength: 131072,
  };
  // Beyond any real release, so every running instance must filter it out.
  const futureV2Model = { ...v2Model, entryVersion: "999.0.0" };
  const malformedV2Model = { ...v2Model, weight: "heavy" };

  const DIGEST = "abc123";

  let server: ReturnType<typeof Bun.serve>;
  let requests: string[];
  let failing: boolean;
  let body: Record<string, unknown>;

  beforeEach(() => {
    requests = [];
    failing = false;
    body = { models: { "llama-vllm": v2Model } };

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        requests.push(path);
        if (failing) {
          return new Response("boom", { status: 500 });
        }
        if (path !== "/models/v2.json") {
          return new Response("not found", { status: 404 });
        }
        if (req.headers.get("if-none-match") === `"${DIGEST}"`) {
          return new Response(null, { status: 304, headers: { ETag: `"${DIGEST}"` } });
        }
        return Response.json(body, { headers: { ETag: `"${DIGEST}"` } });
      },
    });
  });

  afterEach(() => server.stop(true));

  const makeClient = (cacheTtlMs = 0) =>
    createCatalogClient({ baseUrl: `http://localhost:${server.port}`, cacheTtlMs });

  it("keeps the snapshot when the server answers 304", async () => {
    const client = makeClient();

    expect((await client.get("llama-vllm"))?.engineSpecifier).toBe("org/llama-vllm");
    expect((await client.get("llama-vllm"))?.engineSpecifier).toBe("org/llama-vllm");

    expect(requests).toHaveLength(2);
    expect(client.digest).toBe(DIGEST);
  });

  it("serves the last snapshot when a later refresh fails", async () => {
    const client = makeClient();
    await client.get("llama-vllm");

    failing = true;

    expect((await client.get("llama-vllm"))?.engineSpecifier).toBe("org/llama-vllm");
  });

  it("reports unavailable when it never managed to load", async () => {
    failing = true;
    const client = makeClient();

    const result = await client.lookup("llama-vllm");
    expect(result.status).toBe("unavailable");
  });

  it("shares one request between concurrent callers", async () => {
    const client = makeClient();

    await Promise.all([
      client.get("llama-vllm"),
      client.get("llama-vllm"),
      client.getAll(),
    ]);

    expect(requests).toHaveLength(1);
  });

  it("drops entries this version is too old for, and invalid ones", async () => {
    body = {
      models: {
        "llama-vllm": v2Model,
        "future-vllm": futureV2Model,
        "malformed-vllm": malformedV2Model,
      },
    };
    const client = makeClient();

    const specifiers = (await client.getAll()).map(m => m.publicSpecifier);
    expect(specifiers).toEqual(["llama-vllm"]);
    expect(await client.lookup("future-vllm")).toEqual({ status: "not_found" });
  });

  it("resolves a batch from the snapshot without extra requests", async () => {
    const client = makeClient(60_000);
    await client.get("llama-vllm");

    const resolved = await client.resolveBatch(["llama-vllm", "missing"]);

    expect(resolved["llama-vllm"]?.engineSpecifier).toBe("org/llama-vllm");
    expect(resolved["missing"]).toBeNull();
    expect(requests).toHaveLength(1);
  });
});
