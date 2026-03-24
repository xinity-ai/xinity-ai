import { describe, test, expect, mock, jest, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

// DB mock: chain .select().from().where() and .select({...}).from().innerJoin().where()
let deploymentRows: any[] = [];
let installationRows: any[] = [];

const mockWhere = jest.fn(() => deploymentRows);
const mockFrom = jest.fn(() => ({ where: mockWhere }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

// For the join query (getModelSources)
const mockJoinWhere = jest.fn(() => installationRows);
const mockInnerJoin = jest.fn(() => ({ where: mockJoinWhere }));
const mockJoinFrom = jest.fn(() => ({ innerJoin: mockInnerJoin }));
const mockJoinSelect = jest.fn(() => ({ from: mockJoinFrom }));

// getDB returns a query builder - route calls based on select() arguments
const mockGetDB = jest.fn(() => ({
  select: (...args: unknown[]) => {
    // select with field mapping = getModelSources; select() without args = publicModelSpecifierToModelSource
    if (args.length > 0 && typeof args[0] === "object") {
      return mockJoinSelect();
    }
    return mockSelect();
  },
}));

mock.module("../db", () => ({
  getDB: mockGetDB,
}));

const mockSelectHost = jest.fn<() => Promise<{ host: string; useFinalModel: boolean; release: () => void } | null>>();

const mockResolveModelMeta = jest.fn(async () => ({ type: "chat", tags: ["tools"] }));
const mockResolveRequestParams = jest.fn(async () => ({}));

mock.module("xinity-infoserver", () => ({
  createInfoserverClient: () => ({
    resolveModelMeta: mockResolveModelMeta,
    resolveRequestParams: mockResolveRequestParams,
  }),
  BLOCKED_REQUEST_PARAM_PREFIXES: ["chat_template", "tokenize", "prompt", "api_key"],
}));

// We need to mock common-db's calcCanaryProgress and table references
const mockCalcCanaryProgress = jest.fn(() => 100);
mock.module("common-db", () => ({
  calcCanaryProgress: mockCalcCanaryProgress,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  modelDeploymentT: {
    organizationId: "organizationId",
    publicSpecifier: "publicSpecifier",
    enabled: "enabled",
    deletedAt: "deletedAt",
  },
  modelInstallationT: {
    nodeId: "nodeId",
    model: "model",
    port: "port",
    driver: "driver",
    deletedAt: "deletedAt",
  },
  aiNodeT: {
    id: "id",
    host: "host",
    port: "port",
    deletedAt: "deletedAt",
  },
}));

const { getModelInfo, _deps } = await import("./model-data");
_deps.selectHost = mockSelectHost as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setDeployment(d: {
  modelSpecifier: string;
  earlyModelSpecifier?: string | null;
}) {
  deploymentRows = [d];
}

function setInstallations(rows: Array<{ host: string; nodePort: number; modelPort: number; driver: string }>) {
  installationRows = rows;
}

const noop = () => {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  deploymentRows = [];
  installationRows = [];
  mockWhere.mockReset();
  mockWhere.mockImplementation(() => deploymentRows);
  mockJoinWhere.mockReset();
  mockJoinWhere.mockImplementation(() => installationRows);
  mockSelectHost.mockReset();
  mockCalcCanaryProgress.mockReset();
  mockCalcCanaryProgress.mockReturnValue(100);
  mockResolveModelMeta.mockReset();
  mockResolveModelMeta.mockResolvedValue({ type: "chat", tags: ["tools"] });
  mockResolveRequestParams.mockReset();
  mockResolveRequestParams.mockResolvedValue({});
});

describe("getModelInfo", () => {
  test("returns undefined when deployment is not found", async () => {
    deploymentRows = [];
    const result = await getModelInfo("org-1", "nonexistent", "key-1");
    expect(result).toBeUndefined();
  });

  test("returns undefined when selectHost returns null (no available hosts)", async () => {
    setDeployment({ modelSpecifier: "llama3:latest" });
    setInstallations([]);
    mockSelectHost.mockResolvedValue(null);

    const result = await getModelInfo("org-1", "my-model", "key-1");
    expect(result).toBeUndefined();
  });

  test("resolves model info for a simple deployment (no canary)", async () => {
    setDeployment({ modelSpecifier: "llama3:latest", earlyModelSpecifier: null });
    setInstallations([{ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "ollama" }]);
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
    setDeployment({ modelSpecifier: "llama3:latest", earlyModelSpecifier: "llama2:latest" });
    mockCalcCanaryProgress.mockReturnValue(30);

    // Both model queries return installations
    let callCount = 0;
    mockJoinWhere.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Final model sources
        return [{ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" }];
      }
      // Early model sources
      return [{ host: "node-b", nodePort: 11434, modelPort: 11434, driver: "ollama" }];
    });

    mockSelectHost.mockResolvedValue({ host: "node-b:11434", useFinalModel: false, release: noop });

    const result = await getModelInfo("org-1", "my-model", "key-1");

    expect(result).toBeDefined();
    expect(result!.model).toBe("llama2:latest");
    expect(result!.host).toBe("node-b:11434");
  });

  test("falls back to 'ollama' driver when host not in either driver map", async () => {
    setDeployment({ modelSpecifier: "llama3:latest" });
    setInstallations([{ host: "192.168.1.10", nodePort: 11434, modelPort: 11434, driver: "vllm" }]);
    // selectHost returns a host that's NOT in the driverMap (e.g. from a race or stale data)
    mockSelectHost.mockResolvedValue({ host: "unknown-host:8000", useFinalModel: true, release: noop });

    const result = await getModelInfo("org-1", "my-model", "key-1");

    expect(result).toBeDefined();
    expect(result!.driver).toBe("ollama");
  });

  test("correctly resolves vllm driver from driver map", async () => {
    setDeployment({ modelSpecifier: "mistral:latest" });
    mockJoinWhere.mockReset();
    mockJoinWhere.mockReturnValue([{ host: "gpu-node", nodePort: 8000, modelPort: 8000, driver: "vllm" }]);
    mockSelectHost.mockResolvedValue({ host: "gpu-node:8000", useFinalModel: true, release: noop });

    const result = await getModelInfo("org-1", "my-model", "key-1");

    expect(result).toBeDefined();
    expect(result!.driver).toBe("vllm");
  });

  test("passes canary progress and host lists to selectHost", async () => {
    setDeployment({ modelSpecifier: "llama3:latest", earlyModelSpecifier: "llama2:latest" });
    mockCalcCanaryProgress.mockReturnValue(50);

    let callCount = 0;
    mockJoinWhere.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return [{ host: "final-node", nodePort: 11434, modelPort: 11434, driver: "ollama" }];
      }
      return [{ host: "early-node", nodePort: 11434, modelPort: 11434, driver: "ollama" }];
    });

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
    setDeployment({ modelSpecifier: "llama3:latest" });
    // Same host:port appears twice (e.g. two replicas on same node)
    mockJoinWhere.mockReset();
    mockJoinWhere.mockReturnValue([
      { host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" },
      { host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" },
    ]);
    mockSelectHost.mockResolvedValue({ host: "node-a:11434", useFinalModel: true, release: noop });

    await getModelInfo("org-1", "my-model", "key-1");

    // Hosts passed to selectHost should be deduplicated
    const call = mockSelectHost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[1].hosts).toEqual(["node-a:11434"]);
  });

  test("queries infoserver for model metadata", async () => {
    setDeployment({ modelSpecifier: "llama3:latest" });
    setInstallations([{ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" }]);
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
    setDeployment({ modelSpecifier: "llama3:latest", earlyModelSpecifier: null });
    setInstallations([{ host: "node-a", nodePort: 11434, modelPort: 11434, driver: "ollama" }]);
    mockSelectHost.mockResolvedValue({ host: "node-a:11434", useFinalModel: true, release: noop });

    await getModelInfo("org-1", "my-model", "key-1");

    const call = mockSelectHost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[1].earlyHosts).toEqual([]);
    expect(call[1].hasEarlyModel).toBe(false);
  });
});
