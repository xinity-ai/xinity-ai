import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  cleanupTestData,
  createAiNode,
  createApiKey,
  createModelDeployment,
  createModelInstallation,
  createOrganizationAndApp,
  createReadyInstallationFor,
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
    await createReadyInstallationFor(deployment);

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
          status: "ready",
          max_model_len: expect.any(Number),
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
    await createReadyInstallationFor(deploymentA);
    await createReadyInstallationFor(deploymentB);

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
          object: "model",
          id: deploymentA.publicSpecifier,
          max_model_len: expect.any(Number),
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
          id: deploymentB.publicSpecifier,
          max_model_len: expect.any(Number),
        },
      ],
    });
  });

  it("hides non-ready deployments by default", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });

    const readyDeployment = await createModelDeployment({ orgId, publicSpecifier: `ready-${orgId}` });
    await createReadyInstallationFor(readyDeployment);

    const downloadingDeployment = await createModelDeployment({ orgId, publicSpecifier: `downloading-${orgId}` });
    const installingDeployment = await createModelDeployment({ orgId, publicSpecifier: `installing-${orgId}` });
    const failedDeployment = await createModelDeployment({ orgId, publicSpecifier: `failed-${orgId}` });
    const node = await createAiNode();
    await createModelInstallation({
      nodeId: node.id,
      model: downloadingDeployment.publicSpecifier,
      port: 19990,
      lifecycleState: "downloading",
    });
    await createModelInstallation({
      nodeId: node.id,
      model: installingDeployment.publicSpecifier,
      port: 19991,
      lifecycleState: "installing",
    });
    await createModelInstallation({
      nodeId: node.id,
      model: failedDeployment.publicSpecifier,
      port: 19992,
      lifecycleState: "failed",
    });

    await createModelDeployment({ orgId, publicSpecifier: `noinstall-${orgId}` });

    const res = await fetch(gatewayUrl("/v1/models"), {
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string; status: string }> };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain(readyDeployment.publicSpecifier);
    expect(ids).not.toContain(downloadingDeployment.publicSpecifier);
    expect(ids).not.toContain(installingDeployment.publicSpecifier);
    expect(ids).not.toContain(failedDeployment.publicSpecifier);
    expect(ids).not.toContain(`noinstall-${orgId}`);
    for (const m of body.data) expect(m.status).toBe("ready");
  });

  it("surfaces raw lifecycle states when include_unavailable=true", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });

    const readyDeployment = await createModelDeployment({ orgId, publicSpecifier: `ready-${orgId}` });
    await createReadyInstallationFor(readyDeployment);

    const downloadingDeployment = await createModelDeployment({ orgId, publicSpecifier: `downloading-${orgId}` });
    const installingDeployment = await createModelDeployment({ orgId, publicSpecifier: `installing-${orgId}` });
    const failedDeployment = await createModelDeployment({ orgId, publicSpecifier: `failed-${orgId}` });
    const node = await createAiNode();
    await createModelInstallation({
      nodeId: node.id,
      model: downloadingDeployment.publicSpecifier,
      port: 19980,
      lifecycleState: "downloading",
    });
    await createModelInstallation({
      nodeId: node.id,
      model: installingDeployment.publicSpecifier,
      port: 19981,
      lifecycleState: "installing",
    });
    await createModelInstallation({
      nodeId: node.id,
      model: failedDeployment.publicSpecifier,
      port: 19982,
      lifecycleState: "failed",
    });

    const noInstallDeployment = await createModelDeployment({ orgId, publicSpecifier: `noinstall-${orgId}` });

    const res = await fetch(gatewayUrl("/v1/models?include_unavailable=true"), {
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string; status: string | null }> };
    const byId = new Map(body.data.map((m) => [m.id, m.status]));
    expect(byId.get(readyDeployment.publicSpecifier)).toBe("ready");
    expect(byId.get(downloadingDeployment.publicSpecifier)).toBe("downloading");
    expect(byId.get(installingDeployment.publicSpecifier)).toBe("installing");
    expect(byId.get(failedDeployment.publicSpecifier)).toBe("failed");
    expect(byId.get(noInstallDeployment.publicSpecifier)).toBe(null);
  });
  it("includes max_model_len from infoserver catalog", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });
    const deployment = await createModelDeployment({ orgId, specifier: "bge-m3" });
    await createReadyInstallationFor(deployment);

    const res = await fetch(gatewayUrl("/v1/models"), {
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.max_model_len).toBe(8192);
  });

  it("defaults max_model_len to 131072 for unknown models", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });
    const deployment = await createModelDeployment({ orgId, specifier: "unknown-model-xyz-123" });
    await createReadyInstallationFor(deployment);

    const res = await fetch(gatewayUrl("/v1/models"), {
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.max_model_len).toBe(131072);
  });
});
