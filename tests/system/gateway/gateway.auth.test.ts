import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  cleanupTestData,
  createApiKey,
  createOrganizationAndApp,
  ensureGatewayRunning,
  gatewayUrl,
  makeUnknownKey,
} from "./gateway-test-helpers";

beforeAll(async () => {
  await ensureGatewayRunning();
});

afterAll(async () => {
  try { await cleanupTestData(); } catch {}
});

describe("xinity-ai-gateway auth", () => {
  it("rejects requests without an API key", async () => {
    const res = await fetch(gatewayUrl("/v1/models"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "Missing API Key", type: "authentication_error", param: null, code: null } });
  }, {timeout: 50_000});

  it("rejects requests with an unknown API key", async () => {
    const res = await fetch(gatewayUrl("/v1/models"), {
      headers: { authorization: `Bearer ${makeUnknownKey()}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "API Key not found", type: "authentication_error", param: null, code: null } });
  });

  it("rejects requests with a disabled API key", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId, enabled: false });

    const res = await fetch(gatewayUrl("/v1/models"), {
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "API Key is disabled", type: "authentication_error", param: null, code: null } });
  });

  it("rejects requests with a deleted API key", async () => {
    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId, deletedAt: new Date() });

    const res = await fetch(gatewayUrl("/v1/models"), {
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "API Key has been deleted", type: "authentication_error", param: null, code: null } });
  });
});
