import { afterAll, afterEach, beforeAll, describe, expect, mock, test, jest } from "bun:test";
import { mockBackendFetch, modelFound } from "./test-helpers";

import type { checkAuth as checkAuthT } from "../auth";
import type { getModelInfo as getModelInfoT } from "../model-data";

const checkAuth = jest.fn<typeof checkAuthT>(async () => ({
  orgId: "org-1",
  keyId: "key-1",
  applicationId: "app-1",
  collectData: true,
}));

mock.module("../auth", () => ({
  checkAuth,
}));

let mockPort = 0;
const getModelInfo = jest.fn<typeof getModelInfoT>(async () => modelFound({
  installationId: "inst-1",
  nodeId: "node-1",
  host: `localhost:${mockPort}`,
  specifier: "test-rerank",
  model: "test-rerank",
  driver: "vllm",
  authToken: null,
  tls: false,
  type: "rerank",
  tags: [],
  requestParams: {},
  maxContextLength: 131072,
  release: () => {},
}));

mock.module("../model-data", () => ({
  getModelInfo,
}));

mockBackendFetch();

const recordUsageEvent = mock((_record: unknown) => {});
mock.module("../../usageRecorder", () => ({
  recordUsageEvent,
}));

const { handleRerank } = await import("./handle-rerank");

let server: ReturnType<typeof Bun.serve>;
let upstreamUsage: unknown;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      id: "rerank-1",
      results: [{ index: 0, relevance_score: 0.9 }],
      usage: upstreamUsage,
    }),
  });
  mockPort = server.port!;
});

afterEach(() => {
  recordUsageEvent.mockClear();
});

afterAll(() => {
  server.stop();
});

function rerankRequest(): Request {
  return new Request("http://localhost:4000/v1/rerank", {
    method: "POST",
    headers: { "Authorization": "Bearer test" },
    body: JSON.stringify({ model: "test-rerank", query: "q", documents: ["a"] }),
  });
}

describe("handleRerank", () => {
  test("records the backend's total tokens as input tokens", async () => {
    upstreamUsage = { total_tokens: 12 };

    const res = await handleRerank(rerankRequest());

    expect(res.status).toBe(200);
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({
      apiKeyId: "key-1",
      model: "test-rerank",
      inputTokens: 12,
      outputTokens: 0,
      success: true,
    });
  });

  test("still answers when the backend reports no usage", async () => {
    upstreamUsage = undefined;

    const res = await handleRerank(rerankRequest());

    expect(res.status).toBe(200);
  });
});
