import { describe, test, expect, mock, jest, beforeEach } from "bun:test";
import { drizzle, modelDeploymentT } from "common-db";

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
const preparedProto = Object.getPrototypeOf(db.select().from(modelDeploymentT).prepare("_spy"));
jest.spyOn(preparedProto, "execute").mockImplementation(async function () {
  return queryQueue.shift() ?? [];
});

mock.module("../db", () => ({
  getDB: () => db,
}));

const mockResolveModelMeta = jest.fn(async () => ({ type: "chat" as string | undefined, tags: ["tools"] as string[] }));
const mockResolveRequestParams = jest.fn(async () => ({} as Record<string, string>));

mock.module("xinity-infoserver", () => ({
  createInfoserverClient: () => ({
    resolveModelMeta: mockResolveModelMeta,
    resolveRequestParams: mockResolveRequestParams,
  }),
  BLOCKED_REQUEST_PARAM_PREFIXES: ["chat_template", "tokenize", "prompt", "api_key"],
}));

const { getModelInfo, _deps } = await import("./model-data");
const mockSelectHost = jest.fn<() => Promise<{ host: string; useFinalModel: boolean; release: () => void } | null>>();
_deps.selectHost = mockSelectHost as any;

function deploymentResult(d: {
  modelSpecifier: string;
  earlyModelSpecifier?: string | null;
  progress?: number;
}): Record<string, unknown> {
  return {
    id: "dep-id",
    organizationId: "org-1",
    name: "Test Deployment",
    description: null,
    enabled: true,
    publicSpecifier: "my-model",
    modelSpecifier: d.modelSpecifier,
    earlyModelSpecifier: d.earlyModelSpecifier ?? null,
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

beforeEach(() => {
  queryQueue.length = 0;
  mockSelectHost.mockReset();
  mockResolveModelMeta.mockReset();
  mockResolveModelMeta.mockResolvedValue({ type: "chat", tags: ["tools"] });
  mockResolveRequestParams.mockReset();
  mockResolveRequestParams.mockResolvedValue({});
});

describe("getModelInfo", () => {
  test("returns undefined when deployment is not found", async () => {
    queryQueue.push([]);
    const result = await getModelInfo("org-1", "nonexistent", "key-1");
    expect(result).toBeUndefined();
  });

  test("returns undefined when selectHost returns null (no available hosts)", async () => {
    queryQueue.push([deploymentResult({ modelSpecifier: "llama3:latest" })]);
    queryQueue.push([]);
    mockSelectHost.mockResolvedValue(null);

    const result = await getModelInfo("org-1", "my-model", "key-1");
    expect(result).toBeUndefined();
  });

  test("resolves model info for a simple deployment (no canary)", async () => {
    queryQueue.push([deploymentResult({ modelSpecifier: "llama3:latest", earlyModelSpecifier: null })]);
    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "192.168.1.10:11434", useFinalModel: true, release: noop });

    const result = await getModelInfo("org-1", "my-model", "key-1");

    expect(result).toBeDefined();
    expect(result!.host).toBe("192.168.1.10:11434");
    expect(result!.model).toBe("llama3:latest");
    expect(result!.driver).toBe("ollama");
    expect(result!.type).toBe("chat");
    expect(result!.tags).toEqual(["tools"]);
    expect(typeof result!.release).toBe("function");
  });

  test("resolves early model when canary routes to it", async () => {
    queryQueue.push([deploymentResult({ modelSpecifier: "llama3:latest", earlyModelSpecifier: "llama2:latest", progress: 30 })]);
    queryQueue.push([installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    queryQueue.push([installationResult({ host: "node-b", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "node-b:11434", useFinalModel: false, release: noop });

    const result = await getModelInfo("org-1", "my-model", "key-1");

    expect(result).toBeDefined();
    expect(result!.model).toBe("llama2:latest");
    expect(result!.host).toBe("node-b:11434");
  });

  test("falls back to 'ollama' driver when host not in either driver map", async () => {
    queryQueue.push([deploymentResult({ modelSpecifier: "llama3:latest" })]);
    queryQueue.push([installationResult({ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "vllm" })]);
    mockSelectHost.mockResolvedValue({ host: "unknown-host:8000", useFinalModel: true, release: noop });

    const result = await getModelInfo("org-1", "my-model", "key-1");

    expect(result).toBeDefined();
    expect(result!.driver).toBe("ollama");
  });

  test("correctly resolves vllm driver from driver map", async () => {
    queryQueue.push([deploymentResult({ modelSpecifier: "mistral:latest" })]);
    queryQueue.push([installationResult({ host: "gpu-node", nodePort: 8000, modelPort: 8000, driver: "vllm" })]);
    mockSelectHost.mockResolvedValue({ host: "gpu-node:8000", useFinalModel: true, release: noop });

    const result = await getModelInfo("org-1", "my-model", "key-1");

    expect(result).toBeDefined();
    expect(result!.driver).toBe("vllm");
  });

  test("passes canary progress and host lists to selectHost", async () => {
    queryQueue.push([deploymentResult({ modelSpecifier: "llama3:latest", earlyModelSpecifier: "llama2:latest", progress: 50 })]);
    queryQueue.push([installationResult({ host: "final-node", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    queryQueue.push([installationResult({ host: "early-node", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "final-node:11434", useFinalModel: true, release: noop });

    await getModelInfo("org-1", "my-model", "key-1");

    expect(mockSelectHost).toHaveBeenCalledWith("random", {
      hosts: ["final-node:11434"],
      earlyHosts: ["early-node:11434"],
      canaryProgress: 50,
      hasEarlyModel: true,
      keyId: "key-1",
      publicModel: "my-model",
    });
  });

  test("deduplicates hosts from installations", async () => {
    queryQueue.push([deploymentResult({ modelSpecifier: "llama3:latest" })]);
    queryQueue.push([
      installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" }),
      installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" }),
    ]);
    mockSelectHost.mockResolvedValue({ host: "node-a:11434", useFinalModel: true, release: noop });

    await getModelInfo("org-1", "my-model", "key-1");

    const call = mockSelectHost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[1].hosts).toEqual(["node-a:11434"]);
  });

  test("queries infoserver for model metadata", async () => {
    queryQueue.push([deploymentResult({ modelSpecifier: "llama3:latest" })]);
    queryQueue.push([installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "node-a:11434", useFinalModel: true, release: noop });
    mockResolveModelMeta.mockResolvedValue({ type: "embedding", tags: ["multilingual"] });
    mockResolveRequestParams.mockResolvedValue({ "top_k": "number" });

    const result = await getModelInfo("org-1", "my-model", "key-1");

    expect(result!.type).toBe("embedding");
    expect(result!.tags).toEqual(["multilingual"]);
    expect(result!.requestParams).toEqual({ "top_k": "number" });
    expect(mockResolveModelMeta).toHaveBeenCalledWith("llama3:latest");
    expect(mockResolveRequestParams).toHaveBeenCalledWith("llama3:latest");
  });

  test("skips early model lookup when earlyModelSpecifier is null", async () => {
    queryQueue.push([deploymentResult({ modelSpecifier: "llama3:latest", earlyModelSpecifier: null })]);
    queryQueue.push([installationResult({ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" })]);
    mockSelectHost.mockResolvedValue({ host: "node-a:11434", useFinalModel: true, release: noop });

    await getModelInfo("org-1", "my-model", "key-1");

    const call = mockSelectHost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[1].earlyHosts).toEqual([]);
    expect(call[1].hasEarlyModel).toBe(false);
  });
});
