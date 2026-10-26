import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cleanupTestData, createLegacyApiCall, createOrganizationAndApp, ensureGatewayRunning, gatewayUrl, stopGateway } from "./gateway-test-helpers";
import { metricsAuthHeaders } from "../test-helpers";

beforeAll(async () => {
  await ensureGatewayRunning();
});

afterAll(async () => {
  await cleanupTestData();
  await stopGateway();
});

async function detailView(): Promise<{ ok: boolean; checks: Record<string, string>; deprecations: { id: string; removedIn: string; message: string }[] }> {
  const res = await fetch(gatewayUrl("/health"), { headers: metricsAuthHeaders });
  expect(res.status).toBe(200);
  return res.json() as never;
}

describe("xinity-ai-gateway health", () => {
  it("answers ready without revealing details", async () => {
    const res = await fetch(gatewayUrl("/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reports its dependencies to a credentialed caller", async () => {
    const body = await detailView();
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({ database: "ok", redis: "ok" });
    expect(Array.isArray(body.deprecations)).toBe(true);
  });

  it("reports calls left in the legacy table as a deprecation", async () => {
    const { orgId } = await createOrganizationAndApp();
    await createLegacyApiCall(orgId);

    const legacyCalls = (await detailView()).deprecations.find((d) => d.id === "dashboard.legacy-api-calls");
    expect(legacyCalls?.removedIn).toBe("1.0.0");
    expect(legacyCalls?.message).toContain("still in the legacy table");
  });
});
