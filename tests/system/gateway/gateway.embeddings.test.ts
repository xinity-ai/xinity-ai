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
  startMockEmbeddingServer,
} from "./gateway-test-helpers";

beforeAll(async () => {
  await ensureGatewayRunning();
});

afterAll(async () => {
  try { await cleanupTestData(); } catch {}
});

describe("xinity-ai-gateway embeddings", () => {
  it("forwards embedding requests when model installation exists", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });

    const publicSpecifier = `public-embed-${orgId}`;
    const internalModel = `internal-embed-${orgId}`;
    await createModelDeployment({
      orgId,
      publicSpecifier,
      specifier: internalModel,
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
      specifier: internalModel,
      port: mockServer.port,
      lifecycleState: "ready",
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
