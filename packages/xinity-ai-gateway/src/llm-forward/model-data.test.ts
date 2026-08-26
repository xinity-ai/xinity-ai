import { describe, test, expect, mock, jest, beforeEach, afterEach, spyOn } from "bun:test";
import { drizzle, modelDeploymentT } from "common-db";
import { redis } from "bun";
import type { LegacyModel, Model } from "xinity-infoserver";

mock.module("../env", () => ({
  env: {
    HOST: "localhost",
    PORT: 4010,
    DB_CONNECTION_URL: "postgresql://localhost/test",
    REDIS_URL: "redis://localhost:6379",
    INFOSERVER_URL: "http://localhost:3000",
    INFOSERVER_CACHE_TTL_MS: 30000,
    LOAD_BALANCE_STRATEGY: "random",
    BACKEND_TIMEOUT_MS: 300000,
    LOG_LEVEL: "silent",
    LOG_DIR: undefined,
    METRICS_AUTH: undefined,
  },
}));

const db = drizzle.mock();
const queryQueue: Record<string, unknown>[][] = [];
let executeCount = 0;
let gatedExecute: { at: number; entered: () => void; released: Promise<void> } | null = null;
const preparedProto = Object.getPrototypeOf(db.select().from(modelDeploymentT).prepare("_spy"));
jest.spyOn(preparedProto, "execute").mockImplementation(async function () {
  executeCount += 1;
  if (gatedExecute?.at === executeCount) {
    gatedExecute.entered();
    await gatedExecute.released;
  }
  return queryQueue.shift() ?? [];
});

mock.module("../db", () => ({
  getDB: () => db,
}));

type MockLegacyModel = Pick<LegacyModel, "type" | "tags" | "providerTags" | "requestParams" | "providers">;

type MockModel = Pick<Model, "engineSpecifier" | "engine" | "type" | "tags" | "sizing" | "requestParams">;

const mockFetchModel = jest.fn<(specifier: string) => Promise<MockLegacyModel | undefined>>();
const mockLookup = jest.fn<(specifier: string) => Promise<{ status: string; model?: MockModel; error?: string }>>();

function resolveTagsForDriver(model: MockLegacyModel, driver: "vllm" | "ollama"): string[] {
  return model.providerTags?.[driver] ?? model.tags ?? [];
}

function resolveRequestParamsForDriver(model: MockLegacyModel, driver: "vllm" | "ollama"): Record<string, string> {
  return model.requestParams?.[driver] ?? {};
}

mock.module("xinity-infoserver", () => ({
  createCatalogClient: () => ({
    lookup: mockLookup,
  }),
  createInfoserverClient: () => ({
    fetchModel: mockFetchModel,
  }),
  resolveTagsForDriver,
  resolveRequestParamsForDriver,
  BLOCKED_REQUEST_PARAM_PREFIXES: ["chat_template", "tokenize", "prompt", "api_key"],
}));

const { getModelInfo, invalidateModelSources, invalidateDeployments, _deps } = await import("./model-data");
const mockSelectHost = jest.fn<() => Promise<{ host: string; useFinalModel: boolean; release: () => void } | null>>();
_deps.selectHost = mockSelectHost as any;

function deploymentResult(d: {
  specifier: string;
  earlySpecifier?: string | null;
  progress?: number;
}): Record<string, unknown> {
  return {
    id: "dep-id",
    organizationId: "org-1",
    name: "Test Deployment",
    description: null,
    enabled: true,
    publicSpecifier: "my-model",
    specifier: d.specifier,
    earlySpecifier: d.earlySpecifier ?? null,
    replicas: 1,
    canaryProgressUntil: null,
    canaryProgressFrom: null,
    canaryProgressWithFeedback: false,
    progress: d.progress ?? 100,
    kvCacheSize: null,
    earlyKvCacheSize: null,
    preferredDriver: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function installationResult(r: { host: string; nodePort: number; modelPort: number; driver: string }): Record<string, unknown> {
  return { host: r.host, nodePort: r.nodePort, modelPort: r.modelPort, driver: r.driver };
}

const noop = () => {};

let mockRedisGet: ReturnType<typeof spyOn>;
let mockRedisSet: ReturnType<typeof spyOn>;
const redisStore = new Map<string, string>();

beforeEach(() => {
  invalidateModelSources();
  queryQueue.length = 0;
  executeCount = 0;
  gatedExecute = null;
  redisStore.clear();
  mockSelectHost.mockReset();
  mockLookup.mockReset();
  // The legacy specifiers these tests use are absent from the current catalog.
  mockLookup.mockResolvedValue({ status: "not_found" });
  mockFetchModel.mockReset();
  mockFetchModel.mockImplementation(async (specifier) => {
    return { type: "chat", tags: ["tools"], providers: { ollama: specifier, vllm: specifier } };
  });

  mockRedisGet = spyOn(redis, "get").mockImplementation(async (key: string) => {
    return redisStore.get(key) ?? null;
  });
  mockRedisSet = spyOn(redis, "set").mockImplementation(async (key: string, val: string) => {
    redisStore.set(key, val);
    return "OK" as any;
  });
});

afterEach(() => {
  mockRedisGet.mockRestore();
  mockRedisSet.mockRestore();
});

describe("getModelInfo", () => {
  test("returns undefined when deployment is not found", async () => {
    queryQueue.push([]);
    const result = await getModelInfo("org-1", "nonexistent");
    expect(result).toBeUndefined();
  });

  test("returns undefined when selectHost returns null (no available hosts)", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest" })]);
    queryQueue.push([]);
    mockSelectHost.mockResolvedValue(null);

    const result = await getModelInfo("org-1", "my-model");
    expect(result).toBeUndefined();
  });

  test("resolves model info for a simple deployment (no canary)", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest", earlySpecifier: null })]);
    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "192.168.1.10:11434", useFinalModel: true, release: noop });

    const result = await getModelInfo("org-1", "my-model");

    expect(result).toBeDefined();
    expect(result!.host).toBe("192.168.1.10:11434");
    expect(result!.model).toBe("llama3:latest");
    expect(result!.driver).toBe("ollama");
    expect(result!.type).toBe("chat");
    expect(result!.tags).toEqual(["tools"]);
    expect(typeof result!.release).toBe("function");
  });

  test("resolves early model when canary routes to it", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest", earlySpecifier: "llama2:latest", progress: 30 })]);
    queryQueue.push([installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    queryQueue.push([installationResult({ host: "node-b", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "node-b:11434", useFinalModel: false, release: noop });

    const result = await getModelInfo("org-1", "my-model");

    expect(result).toBeDefined();
    expect(result!.model).toBe("llama2:latest");
    expect(result!.host).toBe("node-b:11434");
  });

  test("falls back to 'ollama' driver when host not in either driver map", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest" })]);
    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "vllm" })]);
    mockSelectHost.mockResolvedValue({ host: "unknown-host:8000", useFinalModel: true, release: noop });

    const result = await getModelInfo("org-1", "my-model");

    expect(result).toBeDefined();
    expect(result!.driver).toBe("ollama");
  });

  test("correctly resolves vllm driver from driver map", async () => {
    queryQueue.push([deploymentResult({ specifier: "mistral:latest" })]);
    queryQueue.push([installationResult({ host: "gpu-node", nodePort: 8000, modelPort: 8000, driver: "vllm" })]);
    mockSelectHost.mockResolvedValue({ host: "gpu-node:8000", useFinalModel: true, release: noop });

    const result = await getModelInfo("org-1", "my-model");

    expect(result).toBeDefined();
    expect(result!.driver).toBe("vllm");
  });

  test("passes canary progress and host lists to selectHost", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest", earlySpecifier: "llama2:latest", progress: 50 })]);
    queryQueue.push([installationResult({ host: "final-node", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    queryQueue.push([installationResult({ host: "early-node", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "final-node:11434", useFinalModel: true, release: noop });

    await getModelInfo("org-1", "my-model");

    expect(mockSelectHost).toHaveBeenCalledWith("random", {
      hosts: ["final-node:11434"],
      earlyHosts: ["early-node:11434"],
      canaryProgress: 50,
      hasEarlyModel: true,
      publicModel: "my-model",
      prefixHashes: undefined,
      hostMeta: expect.any(Map),
    });
  });

  test("deduplicates hosts from installations", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest" })]);
    queryQueue.push([
      installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" }),
      installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" }),
    ]);
    mockSelectHost.mockResolvedValue({ host: "node-a:11434", useFinalModel: true, release: noop });

    await getModelInfo("org-1", "my-model");

    const call = mockSelectHost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[1].hosts).toEqual(["node-a:11434"]);
  });

  test("queries infoserver for model metadata", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest" })]);
    queryQueue.push([installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "node-a:11434", useFinalModel: true, release: noop });
    mockFetchModel.mockResolvedValueOnce({
      type: "embedding",
      tags: ["vision"],
      requestParams: { ollama: { "top_k": "number" } },
      providers: { ollama: "llama3:latest", vllm: "llama3:latest" },
    });

    const result = await getModelInfo("org-1", "my-model");

    expect(result!.type).toBe("embedding");
    expect(result!.tags).toEqual(["vision"]);
    expect(result!.requestParams).toEqual({ "top_k": "number" });
    expect(mockFetchModel).toHaveBeenCalledWith("llama3:latest");
  });

  test("passes the specifier through when the model is not in the infoserver catalog", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest" })]);
    queryQueue.push([installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "node-a:11434", useFinalModel: true, release: noop });
    mockFetchModel.mockResolvedValueOnce(undefined);

    const result = await getModelInfo("org-1", "my-model");

    expect(result).toBeDefined();
    expect(result!.model).toBe("llama3:latest");
    expect(result!.specifier).toBe("llama3:latest");
    expect(result!.type).toBeUndefined();
    expect(result!.tags).toBeUndefined();
    expect(result!.requestParams).toBeUndefined();
  });

  test("uses providerTags for the resolved driver when present", async () => {
    queryQueue.push([deploymentResult({ specifier: "mistral:latest" })]);
    queryQueue.push([installationResult({ host: "gpu-node", nodePort: 8000, modelPort: 8000, driver: "vllm" })]);
    mockSelectHost.mockResolvedValue({ host: "gpu-node:8000", useFinalModel: true, release: noop });
    mockFetchModel.mockResolvedValueOnce({
      type: "chat",
      tags: ["tools"],
      providerTags: { vllm: ["tools", "vision"], ollama: ["tools"] },
      providers: { vllm: "mistral:latest", ollama: "mistral:latest" },
    });

    const result = await getModelInfo("org-1", "my-model");

    expect(result!.driver).toBe("vllm");
    expect(result!.tags).toEqual(["tools", "vision"]);
  });

  test("reads metadata off a current-format entry without consulting the legacy catalog", async () => {
    queryQueue.push([deploymentResult({ specifier: "gemma-4-27b-vllm" })]);
    queryQueue.push([installationResult({ host: "gpu-node", nodePort: 8000, modelPort: 8000, driver: "vllm" })]);
    mockSelectHost.mockResolvedValue({ host: "gpu-node:8000", useFinalModel: true, release: noop });
    mockLookup.mockResolvedValue({
      status: "found",
      model: {
        engine: "vllm",
        engineSpecifier: "google/gemma-4-27b-it",
        type: "chat",
        tags: ["tools"],
        sizing: { weightGb: 54, minKvCacheGb: 8, maxContextLength: 8192 },
        requestParams: { "template.thinking": "boolean" },
      },
    });

    const result = await getModelInfo("org-1", "my-model");

    expect(result!.model).toBe("google/gemma-4-27b-it");
    expect(result!.tags).toEqual(["tools"]);
    expect(result!.maxContextLength).toBe(8192);
    expect(result!.requestParams).toEqual({ "template.thinking": "boolean" });
    expect(mockFetchModel).not.toHaveBeenCalled();
  });

  test("skips early model lookup when earlySpecifier is null", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest", earlySpecifier: null })]);
    queryQueue.push([installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "node-a:11434", useFinalModel: true, release: noop });

    await getModelInfo("org-1", "my-model");

    const call = mockSelectHost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[1].earlyHosts).toEqual([]);
    expect(call[1].hasEarlyModel).toBe(false);
  });

  test("uses Redis-cached deployment and source data on subsequent calls without querying DB", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest", earlySpecifier: null })]);
    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "192.168.1.10:11434", useFinalModel: true, release: noop });

    const first = await getModelInfo("org-1", "my-model");
    expect(first).toBeDefined();
    expect(queryQueue.length).toBe(0);

    // Second call without pushing anything into queryQueue: should succeed via in-memory cache
    const second = await getModelInfo("org-1", "my-model");
    expect(second).toBeDefined();
    expect(second!.host).toBe("192.168.1.10:11434");
    expect(queryQueue.length).toBe(0);
  });

  test("a sources query already in flight does not repopulate the cache it raced", async () => {
    // Served from redis so the only database query is the sources lookup we gate.
    redisStore.set("gateway:dep:org-1:my-model", JSON.stringify({
      specifier: "llama3:latest",
      earlySpecifier: null,
      progress: 100,
      canaryProgressFrom: null,
      canaryProgressUntil: null,
    }));

    let release!: () => void;
    let entered!: () => void;
    const reachedGate = new Promise<void>((resolve) => { entered = resolve; });
    gatedExecute = { at: 1, entered, released: new Promise<void>((resolve) => { release = resolve; }) };

    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "192.168.1.10:11434", useFinalModel: true, release: noop });

    const inFlight = getModelInfo("org-1", "my-model");
    await reachedGate;
    invalidateModelSources();
    release();

    expect(await inFlight).toBeDefined();
    expect(executeCount).toBe(1);

    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    await getModelInfo("org-1", "my-model");

    expect(executeCount).toBe(2);
  });
});

describe("invalidateDeployments", () => {
  test("follows the scan cursor to the end and deletes every page", async () => {
    const deleted: string[][] = [];
    const sendSpy = spyOn(redis, "send").mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "SCAN") {
        return args[0] === "0"
          ? ["7", ["gateway:dep:org-1:a"]]
          : ["0", ["gateway:dep:org-2:b"]];
      }
      deleted.push(args);
      return 1 as any;
    });

    await invalidateDeployments();

    expect(deleted).toEqual([["gateway:dep:org-1:a"], ["gateway:dep:org-2:b"]]);
    sendSpy.mockRestore();
  });

  test("skips the delete when a page is empty", async () => {
    let dels = 0;
    const sendSpy = spyOn(redis, "send").mockImplementation(async (cmd: string) => {
      if (cmd === "SCAN") return ["0", []];
      dels += 1;
      return 1 as any;
    });

    await invalidateDeployments();

    expect(dels).toBe(0);
    sendSpy.mockRestore();
  });
});
