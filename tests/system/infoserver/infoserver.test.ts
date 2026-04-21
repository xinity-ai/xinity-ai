import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ensureInfoServerRunning, infoServerUrl, stopInfoServer } from "./infoserver-test-helpers";
import { version } from "../../../package.json";

beforeAll(async () => {
  await ensureInfoServerRunning();
});

afterAll(async () => {
  await stopInfoServer();
});

describe("xinity-infoserver", () => {
  it("responds with health status", async () => {
    const res = await fetch(infoServerUrl("/health"));
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.catalog).toBeDefined();
    expect(body.catalog.modelCount).toBeGreaterThanOrEqual(0);
    expect(body.catalog.lastRefreshAt).toBeTruthy();
    expect(body.catalog.lastRefreshError).toBeNull();
  });

  it("returns the current version", async () => {
    const res = await fetch(infoServerUrl("/version.json"));
    expect(res.ok).toBe(true);
    const body = await res.json();

    expect(body).toEqual({ version: version });
  });

  it("returns the model schema json", async () => {
    const res = await fetch(infoServerUrl("/schemas/model.v1.json"));
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("$schema");
    expect(body).toHaveProperty("type");
  });
});
