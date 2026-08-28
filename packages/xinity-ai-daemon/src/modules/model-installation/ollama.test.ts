import { describe, test, expect, mock, beforeEach } from "bun:test";
import { firstValueFrom } from "rxjs";
import type { InstallationEntry } from "./catalog";

// ---------------------------------------------------------------------------
// Mocks: must be set up before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../../env", () => ({ env: {
  OLLAMA_URL: "http://localhost:11434",
  SYNC_INTERVAL_MS: 60_000,
  STATE_DIR: "/tmp/test-state",
  VLLM_MAX_RESTART_COUNT: 3,
  INFOSERVER_URL: "http://localhost:8090",
  INFOSERVER_CACHE_TTL_MS: 0,
}}));

const mockUpdateState = mock(() => Promise.resolve());

mock.module("./state", () => ({
  updateInstallationState: mockUpdateState,
  getLocalInstallationState: () => undefined,
  getLocalInstallationStates: () => new Map(),
}));

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

// Resolves to the specifier as the ollama tag, so test expectations can use
// specifier and tag interchangeably.
const mockResolveEntry = mock<(specifier: string, engine: string) => Promise<Pick<InstallationEntry, "engineSpecifier"> | undefined>>(
  (specifier) => Promise.resolve({ engineSpecifier: specifier }),
);

mock.module("./catalog", () => ({
  resolveInstallationEntry: mockResolveEntry,
}));

// Track Ollama client calls
const mockOllamaList = mock<() => Promise<{ models: Array<{ model: string }> }>>();
const mockOllamaDelete = mock<(params: { model: string }) => Promise<void>>();
const mockOllamaPull = mock<(params: { model: string; stream: boolean }) => Promise<AsyncIterable<{ status: string; completed: number; total: number }>>>();

mock.module("ollama", () => ({
  Ollama: class MockOllama {
    list = () => mockOllamaList();
    delete = (params: { model: string }) => mockOllamaDelete(params);
    pull = (params: { model: string; stream: boolean }) => mockOllamaPull(params);
  },
}));

const { syncOllamaInstallations$ } = await import("./ollama");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstallation(specifier: string, id = crypto.randomUUID()) {
  return {
    id,
    nodeId: "node-1",
    specifier,
    estCapacity: 8,
    kvCacheCapacity: 0,
    port: 8080,
    driver: "ollama" as const,
    settings: { version: 1 as const },
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
    mockUpdateState.mockClear();
    mockResolveEntry.mockReset();
    mockResolveEntry.mockImplementation((specifier) => Promise.resolve({ engineSpecifier: specifier }));
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

    const installations = [makeInstallation("llama3:latest")];
    await firstValueFrom(syncOllamaInstallations$(installations));

    expect(mockOllamaDelete).toHaveBeenCalledTimes(1);
    expect(mockOllamaDelete).toHaveBeenCalledWith({ model: "mistral:latest" });
  });

  test("pulls models that are desired but not installed", async () => {
    mockOllamaList.mockResolvedValue({ models: [] });

    async function* pullStream() {
      yield { status: "success", completed: 100, total: 100 };
    }
    mockOllamaPull.mockResolvedValue(pullStream());

    const installations = [makeInstallation("phi3:latest")];
    await firstValueFrom(syncOllamaInstallations$(installations));

    expect(mockOllamaPull).toHaveBeenCalledTimes(1);
    expect(mockOllamaPull.mock.calls[0]![0]).toMatchObject({ model: "phi3:latest", stream: true });
  });

  test("skips installations no catalog resolves for ollama", async () => {
    mockOllamaList.mockResolvedValue({ models: [] });
    mockResolveEntry.mockImplementation(() => Promise.resolve(undefined));

    await firstValueFrom(syncOllamaInstallations$([makeInstallation("vllm-only")]));

    expect(mockOllamaPull).not.toHaveBeenCalled();
  });
});
