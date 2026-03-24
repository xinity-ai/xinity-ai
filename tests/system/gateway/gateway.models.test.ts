import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  cleanupTestData,
  createApiKey,
  createModelDeployment,
  createOrganizationAndApp,
  ensureGatewayRunning,
  gatewayUrl,
} from "./gateway-test-helpers";

beforeAll(async () => {
  await ensureGatewayRunning();
});

afterAll(async () => {
  try { await cleanupTestData(); } catch {}
});

describe("xinity-ai-gateway models", () => {
  it("returns an empty list when no models are deployed for the org", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });

    const res = await fetch(gatewayUrl("/v1/models"), {
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ object: "list", data: [] });
  });

  it("returns deployed models for the requesting organization", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });
    const deployment = await createModelDeployment({ orgId });

    const res = await fetch(gatewayUrl("/v1/models"), {
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      object: "list",
      data: [
        {
          id: deployment.publicSpecifier,
          object: "model",
        },
      ],
    });
  });

  it("excludes soft-deleted deployments from model list", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });
    await createModelDeployment({ orgId, deletedAt: new Date() });

    const res = await fetch(gatewayUrl("/v1/models"), {
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ object: "list", data: [] });
  });

  it("isolates model deployments across organizations", async () => {
    const orgA = await createOrganizationAndApp();
    const orgB = await createOrganizationAndApp();
    const keyA = await createApiKey({ orgId: orgA.orgId, appId: orgA.appId });
    const keyB = await createApiKey({ orgId: orgB.orgId, appId: orgB.appId });

    const deploymentA = await createModelDeployment({
      orgId: orgA.orgId,
      publicSpecifier: `org-a-${orgA.orgId}`,
    });
    const deploymentB = await createModelDeployment({
      orgId: orgB.orgId,
      publicSpecifier: `org-b-${orgB.orgId}`,
    });

    const resA = await fetch(gatewayUrl("/v1/models"), {
      headers: { authorization: `Bearer ${keyA.fullKey}` },
    });
    expect(resA.status).toBe(200);
    const bodyA = await resA.json();
    expect(bodyA).toMatchObject({
      object: "list",
      data: [
        {
          id: deploymentA.publicSpecifier,
          object: "model",
        },
      ],
    });

    const resB = await fetch(gatewayUrl("/v1/models"), {
      headers: { authorization: `Bearer ${keyB.fullKey}` },
    });
    expect(resB.status).toBe(200);
    const bodyB = await resB.json();
    expect(bodyB).toMatchObject({
      object: "list",
      data: [
        {
          id: deploymentB.publicSpecifier,
          object: "model",
        },
      ],
    });
  });
});
