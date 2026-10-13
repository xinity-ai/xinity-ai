import { describe, test, expect, mock, jest, beforeEach, afterEach, spyOn } from "bun:test";
import { drizzle, modelDeploymentT } from "common-db";
import { cache } from "../cache";
import type { LegacyModel, Model } from "common-env/model-catalog";
import type { ModelInfo, ModelLookup } from "./model-data";

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

mock.module("common-env/model-catalog", () => ({
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

const { getModelInfo, invalidateModelSources, _deps } = await import("./model-data");
const mockSelectHost = jest.fn<(strategy: unknown, input: { hosts: string[] }) => Promise<{ host: string; useFinalModel: boolean; release: () => void } | null>>();
_deps.selectHost = mockSelectHost as any;
const mockAdmit = jest.fn<(installationId: string, maxNumSeqs: number | null) => Promise<(() => void) | undefined>>(async () => () => {});
_deps.admit = mockAdmit;

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

function installationResult(r: { host: string; nodePort: number; modelPort: number; driver: string; installationId?: string }): Record<string, unknown> {
  return { installationId: r.installationId ?? "inst-1", host: r.host, nodePort: r.nodePort, modelPort: r.modelPort, driver: r.driver };
}

const noop = () => {};

function infoOf(lookup: ModelLookup): ModelInfo | undefined {
  expect(lookup.status).toBe("found");
  return lookup.status === "found" ? lookup.info : undefined;
}

let mockCacheGet: ReturnType<typeof spyOn>;
let mockCacheSet: ReturnType<typeof spyOn>;
const cacheStore = new Map<string, string>();

beforeEach(() => {
  invalidateModelSources();
  queryQueue.length = 0;
  executeCount = 0;
  gatedExecute = null;
  cacheStore.clear();
  mockSelectHost.mockReset();
  mockLookup.mockReset();
  // The legacy specifiers these tests use are absent from the current catalog.
  mockLookup.mockResolvedValue({ status: "not_found" });
  mockFetchModel.mockReset();
  mockFetchModel.mockImplementation(async (specifier) => {
    return { type: "chat", tags: ["tools"], providers: { ollama: specifier, vllm: specifier } };
  });

  mockCacheGet = spyOn(cache, "get").mockImplementation(async (key: string) => {
    return cacheStore.get(key) ?? null;
  });
  mockCacheSet = spyOn(cache, "set").mockImplementation(async (key: string, val: string) => {
    cacheStore.set(key, val);
    return;
  });
});

afterEach(() => {
  mockCacheGet.mockRestore();
  mockCacheSet.mockRestore();
});

describe("getModelInfo", () => {
  test("reports an unknown model when deployment is not found", async () => {
    queryQueue.push([]);
    const result = await getModelInfo("org-1", "nonexistent");
    expect(result.status).toBe("unknown");
  });

  test("reports an unavailable model when selectHost finds no ready hosts", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest" })]);
    queryQueue.push([]);
    mockSelectHost.mockResolvedValue(null);

    const result = await getModelInfo("org-1", "my-model");
    expect(result.status).toBe("unavailable");
  });

  test("routes past a replica that holds its limit, and reports a busy model once every replica does", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest" })]);
    queryQueue.push([
      installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "vllm", installationId: "full" }),
      installationResult({ host: "192.168.1.11", nodePort: 11434, modelPort: 11434, driver: "vllm", installationId: "free" }),
    ]);
    mockSelectHost.mockImplementation(async (_strategy: unknown, input: { hosts: string[] }) =>
      input.hosts.length > 0 ? { host: input.hosts[0]!, useFinalModel: true, release: noop } : null);
    mockAdmit.mockImplementation(async (installationId) => (installationId === "full" ? undefined : noop));
    expect(infoOf(await getModelInfo("org-1", "my-model"))!.installationId).toBe("free");

    mockAdmit.mockImplementation(async () => undefined);
    invalidateModelSources();
    queryQueue.push([deploymentResult({ specifier: "llama3:latest" })]);
    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "vllm", installationId: "full" })]);
    expect((await getModelInfo("org-1", "my-model")).status).toBe("busy");
    mockAdmit.mockImplementation(async () => noop);
  });

  test("resolves model info for a simple deployment (no canary)", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest", earlySpecifier: null })]);
    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "192.168.1.10:11434", useFinalModel: true, release: noop });

    const result = infoOf(await getModelInfo("org-1", "my-model"));

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

    const result = infoOf(await getModelInfo("org-1", "my-model"));

    expect(result).toBeDefined();
    expect(result!.model).toBe("llama2:latest");
    expect(result!.host).toBe("node-b:11434");
  });

  test("reports unavailable when the chosen host serves none of the deployment's installations", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest" })]);
    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "vllm" })]);
    const release = mock(() => {});
    mockSelectHost.mockResolvedValue({ host: "unknown-host:8000", useFinalModel: true, release });

    const lookup = await getModelInfo("org-1", "my-model");

    expect(lookup.status).toBe("unavailable");
    expect(release).toHaveBeenCalled();
  });

  test("routes to the installation serving the chosen host", async () => {
    queryQueue.push([deploymentResult({ specifier: "mistral:latest" })]);
    queryQueue.push([
      installationResult({ host: "gpu-a", nodePort: 8000, modelPort: 8000, driver: "vllm", installationId: "inst-a" }),
      installationResult({ host: "gpu-b", nodePort: 8000, modelPort: 8000, driver: "vllm", installationId: "inst-b" }),
    ]);
    mockSelectHost.mockResolvedValue({ host: "gpu-b:8000", useFinalModel: true, release: noop });

    expect(infoOf(await getModelInfo("org-1", "my-model"))!.installationId).toBe("inst-b");
  });

  test("correctly resolves vllm driver from driver map", async () => {
    queryQueue.push([deploymentResult({ specifier: "mistral:latest" })]);
    queryQueue.push([installationResult({ host: "gpu-node", nodePort: 8000, modelPort: 8000, driver: "vllm" })]);
    mockSelectHost.mockResolvedValue({ host: "gpu-node:8000", useFinalModel: true, release: noop });

    const result = infoOf(await getModelInfo("org-1", "my-model"));

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

    const result = infoOf(await getModelInfo("org-1", "my-model"));

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

    const result = infoOf(await getModelInfo("org-1", "my-model"));

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

    const result = infoOf(await getModelInfo("org-1", "my-model"));

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

    const result = infoOf(await getModelInfo("org-1", "my-model"));

    expect(result!.model).toBe("google/gemma-4-27b-it");
    expect(result!.tags).toEqual(["tools"]);
    expect(result!.maxContextLength).toBe(8192);
    expect(result!.requestParams).toEqual({ "template.thinking": "boolean" });
    expect(mockFetchModel).not.toHaveBeenCalled();
  });

  test("releases the selected host when the catalog lookup fails", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest" })]);
    queryQueue.push([installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    const release = jest.fn();
    mockSelectHost.mockResolvedValue({ host: "node-a:11434", useFinalModel: true, release });
    mockLookup.mockResolvedValue({ status: "unavailable", error: "connection refused" });

    await expect(getModelInfo("org-1", "my-model")).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
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

  test("uses cached deployment and source data on subsequent calls without querying DB", async () => {
    queryQueue.push([deploymentResult({ specifier: "llama3:latest", earlySpecifier: null })]);
    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "192.168.1.10:11434", useFinalModel: true, release: noop });

    const first = infoOf(await getModelInfo("org-1", "my-model"));
    expect(first).toBeDefined();
    expect(queryQueue.length).toBe(0);

    // Second call without pushing anything into queryQueue: should succeed via in-memory cache
    const second = infoOf(await getModelInfo("org-1", "my-model"));
    expect(second).toBeDefined();
    expect(second!.host).toBe("192.168.1.10:11434");
    expect(queryQueue.length).toBe(0);
  });

  test("a sources query already in flight does not repopulate the cache it raced", async () => {
    // Served from the cache so the only database query is the sources lookup we gate.
    cacheStore.set("gateway:deployment:org-1:my-model", JSON.stringify({
      id: "dep-id",
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

    expect((await inFlight).status).toBe("found");
    expect(executeCount).toBe(1);

    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    await getModelInfo("org-1", "my-model");

    expect(executeCount).toBe(2);
  });
});
