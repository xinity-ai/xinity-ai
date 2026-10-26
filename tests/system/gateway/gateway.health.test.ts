import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ensureGatewayRunning, gatewayUrl, stopGateway } from "./gateway-test-helpers";
import { metricsAuthHeaders } from "../test-helpers";

beforeAll(async () => {
  await ensureGatewayRunning();
});

afterAll(async () => {
  await stopGateway();
});

describe("xinity-ai-gateway health", () => {
  it("answers ready without revealing details", async () => {
    const res = await fetch(gatewayUrl("/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reports its dependencies to a credentialed caller", async () => {
    const res = await fetch(gatewayUrl("/health"), { headers: metricsAuthHeaders });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, checks: { database: "ok", redis: "ok" } });
  });
});
