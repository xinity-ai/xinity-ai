import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metricsAuthHeaders } from "../test-helpers";
import { ensureInfoServerRunning, infoServerUrl, stopInfoServer, withInfoServer } from "./infoserver-test-helpers";
import { version } from "../../../package.json";
import { resolveConfig } from "common-env";
import { infoserverConfig, type InfoserverConfig } from "../../../packages/xinity-infoserver/config-schema";
import { burstFor } from "../../../packages/xinity-infoserver/rate-limit";

const { rateLimit } = resolveConfig<InfoserverConfig>(infoserverConfig, { env: { MODEL_INFO_DIR: "." } }).value;
const EXPORT_BURST = burstFor(rateLimit.exportPerMinute);

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
  it("answers ready without revealing details", async () => {
    const res = await fetch(infoServerUrl("/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reports catalog state to a credentialed caller", async () => {
    const res = await fetch(infoServerUrl("/health"), { headers: metricsAuthHeaders });
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({ models: "ok", refresh: "ok" });
    expect(body.models.lastRefreshAt).toBeTruthy();
    expect(body.models.lastRefreshError).toBeNull();
  });

  it("serves metrics to a credentialed scraper only", async () => {
    expect((await fetch(infoServerUrl("/metrics"))).status).toBe(401);

    const res = await fetch(infoServerUrl("/metrics"), { headers: metricsAuthHeaders });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/^infoserver_catalog_models\{catalog="models"\} [1-9]/m);
    expect(text).toContain("infoserver_build_info{");
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

  it("reports both catalogs separately in health", async () => {
    const res = await fetch(infoServerUrl("/health"), { headers: metricsAuthHeaders });
    const body = await res.json() as any;

    expect(body.models.modelCount).toBeGreaterThan(0);
    expect(body.legacy.modelCount).toBeGreaterThan(0);
  });

  it("serves current-format entries and never v1 ones", async () => {
    const res = await fetch(infoServerUrl("/models/v2.json"), { headers: asClient() });
    const body = await res.json() as any;
    const specifiers = Object.keys(body.models);

    expect(specifiers).toContain("qwen3.6-35b-a3b-vllm");
    expect(specifiers).not.toContain("qwen3-coder-next-large");
    expect(Object.values(body.models).every((m: any) => m.engine !== undefined)).toBe(true);
  });

  it("reports a digest matching the catalog etag", async () => {
    const catalog = await fetch(infoServerUrl("/models/v2.json"), { headers: asClient() });
    const { digest } = await (await fetch(infoServerUrl("/models/v2.digest.json"), { headers: asClient() })).json() as any;

    expect(catalog.headers.get("etag")).toBe(`"${digest}"`);
  });

  it("marks the v1 endpoints deprecated", async () => {
    const res = await fetch(infoServerUrl("/api/v1/models"), { headers: asClient() });

    expect(res.ok).toBe(true);
    expect(res.headers.get("deprecation")).toBe("true");
    expect(res.headers.get("link")).toContain('rel="deprecation"');
  });

  it("serves v1 entries on v1 endpoints and never current-format ones", async () => {
    const res = await fetch(infoServerUrl("/api/v1/models?pageSize=200"), { headers: asClient() });
    const body = await res.json() as any;
    const specifiers = body.models.map((m: any) => m.publicSpecifier);

    expect(specifiers).toContain("qwen3-coder-next-large");
    expect(specifiers).not.toContain("qwen3.6-35b-a3b-vllm");
    expect(body.models.every((m: any) => m.providers !== undefined)).toBe(true);
  });

  describe("without a legacy directory", () => {
    it("serves the v1 endpoints as an empty catalog", async () => {
      await withInfoServer({ MODEL_LEGACY_DIR: undefined }, async (url) => {
        const list = await (await fetch(url("/api/v1/models"))).json() as any;
        expect(list.total).toBe(0);

        const dump = await (await fetch(url("/models/v1.json"))).json() as any;
        expect(dump.models).toEqual({});

        const health = await (await fetch(url("/health"), { headers: metricsAuthHeaders })).json() as any;
        expect(health.legacy.modelCount).toBe(0);
        expect(health.ok).toBe(true);
      });
    });

    it("answers 503 while no models are loaded", async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), "infoserver-empty-"));
      try {
        await withInfoServer({ MODEL_INFO_DIR: emptyDir, MODEL_LEGACY_DIR: undefined }, async (url) => {
          const res = await fetch(url("/health"));
          expect(res.status).toBe(503);
          expect(await res.json()).toEqual({ ok: false });
        });
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });

    it("refuses to start when a file in the current directory cannot be used", async () => {
      await expect(
        withInfoServer({ MODEL_INFO_DIR: "./models.legacy.d" }, async () => undefined),
      ).rejects.toThrow(/exited before health check/);
    });
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
