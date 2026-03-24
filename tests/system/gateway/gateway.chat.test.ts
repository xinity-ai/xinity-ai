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
  startMockChatCompletionServer,
} from "./gateway-test-helpers";

beforeAll(async () => {
  await ensureGatewayRunning();
});

afterAll(async () => {
  try { await cleanupTestData(); } catch {}
});

describe("xinity-ai-gateway chat completion", () => {
  it("rejects requests without an API key", async () => {
    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "any", messages: [] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "Missing API Key", type: "authentication_error", param: null, code: null } });
  });

  it("rejects requests with an unknown API key", async () => {
    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${makeUnknownKey()}`,
      },
      body: JSON.stringify({ model: "any", messages: [] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "API Key not found", type: "authentication_error", param: null, code: null } });
  });

  it("rejects requests with a disabled API key", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId, enabled: false });

    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fullKey}`,
      },
      body: JSON.stringify({ model: "any", messages: [] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "API Key is disabled", type: "authentication_error", param: null, code: null } });
  });

  it("rejects requests with a deleted API key", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId, deletedAt: new Date() });

    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fullKey}`,
      },
      body: JSON.stringify({ model: "any", messages: [] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "API Key has been deleted", type: "authentication_error", param: null, code: null } });
  });

  it("fails when the requested model is missing", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });

    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fullKey}`,
      },
      body: JSON.stringify({ model: "missing-model", messages: [] }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "Model not found", type: "not_found_error", param: null, code: null } });
  });

  it("rejects requests targeting a soft-deleted deployment", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });

    const publicSpecifier = `deleted-deploy-${orgId}`;
    const internalModel = `deleted-internal-${orgId}`;
    await createModelDeployment({
      orgId,
      publicSpecifier,
      modelSpecifier: internalModel,
      deletedAt: new Date(),
    });

    const mockServer = await startMockChatCompletionServer();
    const node = await createAiNode();
    await createModelInstallation({
      nodeId: node.id,
      model: internalModel,
      port: mockServer.port,
    });

    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fullKey}`,
      },
      body: JSON.stringify({
        model: publicSpecifier,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "Model not found", type: "not_found_error", param: null, code: null } });

    mockServer.stop();
  });

  it("rejects requests when node is soft-deleted", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });

    const publicSpecifier = `deleted-node-${orgId}`;
    const internalModel = `deleted-node-internal-${orgId}`;
    await createModelDeployment({
      orgId,
      publicSpecifier,
      modelSpecifier: internalModel,
    });

    const mockServer = await startMockChatCompletionServer();
    const node = await createAiNode({ deletedAt: new Date() });
    await createModelInstallation({
      nodeId: node.id,
      model: internalModel,
      port: mockServer.port,
    });

    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fullKey}`,
      },
      body: JSON.stringify({
        model: publicSpecifier,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "Model not found", type: "not_found_error", param: null, code: null } });

    mockServer.stop();
  });

  it("forwards chat completion requests when model installation exists", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });

    const publicSpecifier = `public-${orgId}`;
    const internalModel = `internal-${orgId}`;
    await createModelDeployment({
      orgId,
      publicSpecifier,
      modelSpecifier: internalModel,
    });

    const mockServer = await startMockChatCompletionServer({
      id: "chatcmpl_test",
      object: "chat.completion",
      created: 1_700_000_000,
      model: internalModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "mock-response" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });

    const node = await createAiNode();
    await createModelInstallation({
      nodeId: node.id,
      model: internalModel,
      port: mockServer.port,
    });

    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fullKey}`,
      },
      body: JSON.stringify({
        model: publicSpecifier,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      object: "chat.completion",
      model: publicSpecifier,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "mock-response" },
          finish_reason: "stop",
        },
      ],
    });

    mockServer.stop();
  });
});
