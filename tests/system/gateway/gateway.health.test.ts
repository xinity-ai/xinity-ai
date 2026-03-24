import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ensureGatewayRunning, gatewayUrl, stopGateway } from "./gateway-test-helpers";

beforeAll(async () => {
  await ensureGatewayRunning();
});

afterAll(async () => {
  await stopGateway();
});

describe("xinity-ai-gateway health", () => {
  it("serves the health check endpoint", async () => {
    const res = await fetch(gatewayUrl("/healthCheck"));
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toEqual({ ready: true });
  });
});
