import { describe, test, expect, mock } from "bun:test";
import { createDependencyProbe, createHealthHandler, probeOwnHealth } from "./health";
import { parseMetricsAuth } from "./metrics-auth";
import type { PinoLike } from "./pino-like";

const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;
const request = (authorization?: string) =>
  new Request("http://localhost/health", { headers: authorization ? { authorization } : {} });
const silent: PinoLike = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("createHealthHandler", () => {
  const credentials = parseMetricsAuth("ops:secret");

  test("answers 503 when a readiness check fails", async () => {
    const handler = createHealthHandler({ readiness: { database: () => "unreachable" }, credentials });
    const res = handler(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  test("a failing degraded check does not affect the status", async () => {
    const handler = createHealthHandler({
      readiness: { database: () => null },
      degraded: { redis: () => "unreachable" },
      credentials,
    });
    const res = handler(request(basic("ops", "secret")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, checks: { database: "ok", redis: "unreachable" } });
  });

  test("hides the detail view without a matching credential", async () => {
    const handler = createHealthHandler({ readiness: {}, details: () => ({ tether: "connected" }), credentials });
    expect(await handler(request()).json()).toEqual({ ok: true });
    expect(await handler(request(basic("ops", "wrong"))).json()).toEqual({ ok: true });
  });

  test("never serves the detail view when no credential is configured", async () => {
    const handler = createHealthHandler({ readiness: {}, details: () => ({ tether: "connected" }), credentials: [] });
    expect(await handler(request(basic("ops", "secret"))).json()).toEqual({ ok: true });
  });

  test("service details cannot override ok or checks", async () => {
    const handler = createHealthHandler({
      readiness: { database: () => "unreachable" },
      details: () => ({ ok: true, checks: {}, tether: "connected" }),
      credentials,
    });
    expect(await handler(request(basic("ops", "secret"))).json()).toEqual({
      ok: false,
      checks: { database: "unreachable" },
      tether: "connected",
    });
  });
});

describe("createDependencyProbe", () => {
  test("reports unreachable after a failed ping and recovers after a successful one", async () => {
    let fail = true;
    const onUnreachable = mock(() => {});
    const probe = createDependencyProbe({
      name: "Database",
      ping: async () => {
        if (fail) {
          throw new Error("down");
        }
      },
      log: silent,
      onUnreachable,
    });

    expect(probe.check()).toBeNull();
    await probe.probeNow();
    await probe.probeNow();
    expect(probe.check()).toBe("unreachable");
    expect(onUnreachable).toHaveBeenCalledTimes(1);

    fail = false;
    await probe.probeNow();
    expect(probe.check()).toBeNull();
  });
});

describe("probeOwnHealth", () => {
  test("is true only for a 200 from /health on the wildcard-bound port", async () => {
    let status = 200;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => new Response(null, { status: new URL(req.url).pathname === "/health" ? status : 404 }),
    });
    try {
      expect(await probeOwnHealth({ host: "0.0.0.0", port: server.port, tls: false })).toBe(true);
      status = 503;
      expect(await probeOwnHealth({ host: "0.0.0.0", port: server.port, tls: false })).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("is false when nothing listens", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = closed.port;
    await closed.stop(true);
    expect(await probeOwnHealth({ port, tls: false })).toBe(false);
  });
});
