import { describe, test, expect, mock, beforeEach } from "bun:test";
import { firstValueFrom } from "rxjs";

// ---------------------------------------------------------------------------
// Mocks: must be set up before importing the module under test
// ---------------------------------------------------------------------------

// Mock env to avoid side-effect (parseEnv reads process.env)
mock.module("../../env", () => ({ env: {
  XINITY_OLLAMA_ENDPOINT: "http://localhost:11434",
  DB_CONNECTION_URL: "postgres://localhost/test",
  SYNC_INTERVAL_MS: 60_000,
  STATE_DIR: "/tmp/test-state",
  VLLM_MAX_RESTART_COUNT: 3,
}}));

// Mock DB connection
const mockInsert = mock(() => mockInsertChain);
const mockInsertChain = {
  values: mock(() => mockInsertChain),
  onConflictDoUpdate: mock(() => Promise.resolve()),
};

mock.module("../../db/connection", () => ({
  getDB: () => ({
    insert: mockInsert,
  }),
  listen: mock(),
}));

// Mock logger
mock.module("../../logger", () => ({
  rootLogger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

// Track Ollama client calls
let mockOllamaList = mock<() => Promise<{ models: Array<{ model: string }> }>>();
let mockOllamaDelete = mock<(params: { model: string }) => Promise<void>>();
let mockOllamaPull = mock<(params: { model: string; stream: boolean }) => Promise<AsyncIterable<{ status: string; completed: number; total: number }>>>();

mock.module("ollama", () => ({
  Ollama: class MockOllama {
    list = () => mockOllamaList();
    delete = (params: { model: string }) => mockOllamaDelete(params);
    pull = (params: { model: string; stream: boolean }) => mockOllamaPull(params);
  },
}));

// Now import the module under test
const { syncOllamaInstallations$ } = await import("./ollama");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstallation(model: string, id = crypto.randomUUID()) {
  return {
    id,
    nodeId: "node-1",
    specifier: null,
    model,
    estCapacity: 8,
    kvCacheCapacity: 0,
    port: 8080,
    driver: "ollama" as const,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncOllamaInstallations$", () => {
  beforeEach(() => {
    mockOllamaList.mockReset();
    mockOllamaDelete.mockReset();
    mockOllamaPull.mockReset();
    mockInsert.mockClear();
    mockInsertChain.values.mockClear();
    mockInsertChain.onConflictDoUpdate.mockClear();
  });

  test("does nothing when desired and existing models match", async () => {
    mockOllamaList.mockResolvedValue({
      models: [{ model: "llama3:latest" }],
    });

    const installations = [makeInstallation("llama3:latest")];
    await firstValueFrom(syncOllamaInstallations$(installations));

    expect(mockOllamaDelete).not.toHaveBeenCalled();
    expect(mockOllamaPull).not.toHaveBeenCalled();
  });

  test("removes models not in desired list", async () => {
    mockOllamaList.mockResolvedValue({
      models: [
        { model: "llama3:latest" },
        { model: "mistral:latest" },
      ],
    });
    mockOllamaDelete.mockResolvedValue(undefined);

    // Only llama3 is desired, so mistral should be removed
    const installations = [makeInstallation("llama3:latest")];
    await firstValueFrom(syncOllamaInstallations$(installations));

    expect(mockOllamaDelete).toHaveBeenCalledTimes(1);
    expect(mockOllamaDelete).toHaveBeenCalledWith({ model: "mistral:latest" });
  });

  test("pulls models that are desired but not installed", async () => {
    mockOllamaList.mockResolvedValue({ models: [] });

    // Create an async iterable that immediately completes with success
    async function* pullStream() {
      yield { status: "success", completed: 100, total: 100 };
    }
    mockOllamaPull.mockResolvedValue(pullStream());

    const installations = [makeInstallation("phi3:latest")];
    await firstValueFrom(syncOllamaInstallations$(installations));

    expect(mockOllamaPull).toHaveBeenCalledTimes(1);
    expect(mockOllamaPull.mock.calls[0]![0]).toMatchObject({ model: "phi3:latest", stream: true });
  });

  test("handles combined add and remove", async () => {
    mockOllamaList.mockResolvedValue({
      models: [{ model: "old-model:latest" }],
    });
    mockOllamaDelete.mockResolvedValue(undefined);

    async function* pullStream() {
      yield { status: "success", completed: 100, total: 100 };
    }
    mockOllamaPull.mockResolvedValue(pullStream());

    const installations = [makeInstallation("new-model:latest")];
    await firstValueFrom(syncOllamaInstallations$(installations));

    expect(mockOllamaDelete).toHaveBeenCalledTimes(1);
    expect(mockOllamaDelete).toHaveBeenCalledWith({ model: "old-model:latest" });
    expect(mockOllamaPull).toHaveBeenCalledTimes(1);
  });

  test("removes all models when desired list is empty", async () => {
    mockOllamaList.mockResolvedValue({
      models: [
        { model: "model-a" },
        { model: "model-b" },
      ],
    });
    mockOllamaDelete.mockResolvedValue(undefined);

    await firstValueFrom(syncOllamaInstallations$([]));

    expect(mockOllamaDelete).toHaveBeenCalledTimes(2);
    expect(mockOllamaPull).not.toHaveBeenCalled();
  });

  test("does nothing when both lists are empty", async () => {
    mockOllamaList.mockResolvedValue({ models: [] });

    await firstValueFrom(syncOllamaInstallations$([]));

    expect(mockOllamaDelete).not.toHaveBeenCalled();
    expect(mockOllamaPull).not.toHaveBeenCalled();
  });

  test("updates installation state during pull progress", async () => {
    mockOllamaList.mockResolvedValue({ models: [] });

    async function* pullStream() {
      yield { status: "downloading sha256:abc", completed: 50, total: 100 };
      yield { status: "success", completed: 100, total: 100 };
    }
    mockOllamaPull.mockResolvedValue(pullStream());

    const installations = [makeInstallation("test-model")];
    await firstValueFrom(syncOllamaInstallations$(installations));

    // The DB insert should have been called to update state
    // (bufferTime may batch these, but at least one call should happen)
    expect(mockInsert).toHaveBeenCalled();
  });
});
