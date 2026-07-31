import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ensureInfoServerRunning, infoServerUrl, stopInfoServer } from "./infoserver-test-helpers";
import { version } from "../../../package.json";
import { infoserverEnvSchema } from "../../../packages/xinity-infoserver/env-schema";
import { burstFor } from "../../../packages/xinity-infoserver/rate-limit";

const EXPORT_BURST = burstFor(infoserverEnvSchema.parse({ MODEL_INFO_DIR: "." }).RATE_LIMIT_EXPORT_PER_MINUTE);

/**
 * The test server trusts X-Forwarded-For, so each caller gets its own rate-limit
 * bucket and no test can throttle another.
 */
let clientCounter = 0;
function asClient(): Record<string, string> {
  clientCounter += 1;
  return { "X-Forwarded-For": `10.9.${Math.floor(clientCounter / 250)}.${clientCounter % 250}` };
}

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

  describe.each([
    ["/models/v1.json", "application/json"],
    ["/models/v1.yaml", "application/yaml"],
  ])("%s", (path, contentType) => {
    it("serves a cacheable body", async () => {
      const res = await fetch(infoServerUrl(path), { headers: asClient() });

      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type")).toContain(contentType);
      expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
      expect(res.headers.get("cache-control")).toContain("max-age=");
      expect((await res.text()).length).toBeGreaterThan(0);
    });

    it("keeps the etag stable while the catalog is unchanged", async () => {
      const client = asClient();
      const first = await fetch(infoServerUrl(path), { headers: client });
      const second = await fetch(infoServerUrl(path), { headers: client });

      expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
    });

    it("answers 304 with no body for a matching If-None-Match", async () => {
      const client = asClient();
      const etag = (await fetch(infoServerUrl(path), { headers: client })).headers.get("etag")!;

      const res = await fetch(infoServerUrl(path), { headers: { ...client, "If-None-Match": etag } });

      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("etag")).toBe(etag);
    });

    it("serves the body when the client holds a stale etag", async () => {
      const res = await fetch(infoServerUrl(path), {
        headers: { ...asClient(), "If-None-Match": '"stale"' },
      });

      expect(res.status).toBe(200);
      expect((await res.text()).length).toBeGreaterThan(0);
    });

    it("throttles a client that floods the export", async () => {
      const client = asClient();
      const statuses: number[] = [];

      for (let attempt = 0; attempt < EXPORT_BURST + 5; attempt++) {
        const res = await fetch(infoServerUrl(path), { headers: client });
        statuses.push(res.status);
        await res.arrayBuffer();
        if (res.status === 429) {
          expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
          break;
        }
      }

      expect(statuses[0]).toBe(200);
      expect(statuses).toContain(429);
    });

    it("does not throttle a different client", async () => {
      const res = await fetch(infoServerUrl(path), { headers: asClient() });

      expect(res.status).toBe(200);
    });
  });
});
