import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  cleanupTestData,
  createApiKey,
  createAiNode,
  createModelDeployment,
  createModelInstallation,
  createOrganizationAndApp,
  ensureGatewayRunning,
  gatewayUrl,
  makeUnknownKey,
  startMockEmbeddingServer,
} from "./gateway-test-helpers";

beforeAll(async () => {
  await ensureGatewayRunning();
});

afterAll(async () => {
  try { await cleanupTestData(); } catch {}
});

describe("xinity-ai-gateway embeddings", () => {
  it("rejects requests without an API key", async () => {
    const res = await fetch(gatewayUrl("/v1/embeddings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "any", input: "hello" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "Missing API Key", type: "authentication_error", param: null, code: null } });
  });

  it("rejects requests with an unknown API key", async () => {
    const res = await fetch(gatewayUrl("/v1/embeddings"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${makeUnknownKey()}`,
      },
      body: JSON.stringify({ model: "any", input: "hello" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "API Key not found", type: "authentication_error", param: null, code: null } });
  });

  it("rejects requests with a disabled API key", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId, enabled: false });

    const res = await fetch(gatewayUrl("/v1/embeddings"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fullKey}`,
      },
      body: JSON.stringify({ model: "any", input: "hello" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "API Key is disabled", type: "authentication_error", param: null, code: null } });
  });

  it("rejects requests with a deleted API key", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId, deletedAt: new Date() });

    const res = await fetch(gatewayUrl("/v1/embeddings"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fullKey}`,
      },
      body: JSON.stringify({ model: "any", input: "hello" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "API Key has been deleted", type: "authentication_error", param: null, code: null } });
  });

  it("fails when the requested model is missing", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });

    const res = await fetch(gatewayUrl("/v1/embeddings"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fullKey}`,
      },
      body: JSON.stringify({ model: "missing-model", input: "hello" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "Model not found", type: "not_found_error", param: null, code: null } });
  });

  it("forwards embedding requests when model installation exists", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });

    const publicSpecifier = `public-embed-${orgId}`;
    const internalModel = `internal-embed-${orgId}`;
    await createModelDeployment({
      orgId,
      publicSpecifier,
      modelSpecifier: internalModel,
    });

    const mockServer = await startMockEmbeddingServer({
      object: "list",
      data: [
        {
          object: "embedding",
          embedding: [0.5, 0.25, 0.125],
          index: 0,
        },
      ],
      model: internalModel,
      usage: { prompt_tokens: 2, total_tokens: 2 },
    });

    const node = await createAiNode({ port: mockServer.port });
    await createModelInstallation({
      nodeId: node.id,
      model: internalModel,
      port: mockServer.port,
    });

    const res = await fetch(gatewayUrl("/v1/embeddings"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fullKey}`,
      },
      body: JSON.stringify({
        model: publicSpecifier,
        input: "hello",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      object: "list",
      model: publicSpecifier,
      data: [
        {
          object: "embedding",
          embedding: [0.5, 0.25, 0.125],
          index: 0,
        },
      ],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    });

    mockServer.stop();
  });
});
