import { describe, expect, test } from "bun:test";
import { checkHealthEndpoint, checkSmtp, probeDaemonHealth } from "../../../src/lib/doctor/doctor-probes.ts";
import { FakeHost } from "../../helpers/fake-host.ts";

const SINCE = "2026-10-05T10:00:00.000Z";
const METRICS_AUTH = "ops:secret,reader:other";

type Seen = { path: string; authorization: string | null };

async function withDaemon(
  body: unknown,
  run: (baseUrl: string, seen: Seen[]) => Promise<void>,
  status = 200,
): Promise<void> {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push({ path: new URL(req.url).pathname, authorization: req.headers.get("authorization") });
      return typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status });
    },
  });
  try {
    await run(`http://127.0.0.1:${server.port}`, seen);
  } finally {
    server.stop(true);
  }
}

describe("probeDaemonHealth", () => {
  test("passes a daemon connected to its tether", async () => {
    await withDaemon({ ok: true, tether: { state: "connected", since: SINCE } }, async (baseUrl) => {
      const { checks } = await probeDaemonHealth(new FakeHost(), baseUrl, METRICS_AUTH);

      expect(checks.map((c) => [c.label, c.status])).toEqual([
        ["Health endpoint", "pass"],
        ["Tether connection", "pass"],
      ]);
    });
  });

  test("asks /health with the first METRICS_AUTH pair", async () => {
    await withDaemon({ ok: true }, async (baseUrl, seen) => {
      await probeDaemonHealth(new FakeHost(), baseUrl, METRICS_AUTH);

      expect(seen).toEqual([{ path: "/health", authorization: `Basic ${btoa("ops:secret")}` }]);
    });
  });

  test("sends no credential when none is configured", async () => {
    await withDaemon({ ok: true }, async (baseUrl, seen) => {
      await probeDaemonHealth(new FakeHost(), baseUrl, undefined);

      expect(seen[0]?.authorization).toBeNull();
    });
  });

  test("fails a daemon the tether refuses and names the category", async () => {
    await withDaemon({ ok: true, tether: { state: "refused", reason: "identity_mismatch", since: SINCE } }, async (baseUrl) => {
      const { checks } = await probeDaemonHealth(new FakeHost(), baseUrl, METRICS_AUTH);

      expect(checks[1]).toMatchObject({ status: "fail", message: `Refused (identity_mismatch) since ${SINCE}` });
      expect(checks[1]!.detail).toContain("daemon logs");
    });
  });

  test("checks only the status code when the answer carries no details", async () => {
    await withDaemon({ ok: true }, async (baseUrl) => {
      const { checks } = await probeDaemonHealth(new FakeHost(), baseUrl, undefined);

      expect(checks).toEqual([{ label: "Health endpoint", status: "pass", message: "Reachable (200)" }]);
    });
  });

  test("reports no tether state for a failing health endpoint", async () => {
    await withDaemon("Internal Server Error", async (baseUrl) => {
      const { checks } = await probeDaemonHealth(new FakeHost(), baseUrl, METRICS_AUTH);

      expect(checks).toEqual([{ label: "Health endpoint", status: "fail", message: "Returned 500" }]);
    }, 500);
  });

  test("tells a daemon that predates /health apart from a broken one", async () => {
    await withDaemon("Not found", async (baseUrl) => {
      const { checks } = await probeDaemonHealth(new FakeHost(), baseUrl, METRICS_AUTH);

      expect(checks[0]).toMatchObject({ status: "fail", message: "Returned 404" });
      expect(checks[0]!.detail).toContain("predates /health");
    }, 404);
  });

  test("reads the coupling from the same answer, and none from a daemon without it", async () => {
    const groupMember = {
      specifier: "qwen3.8-27b", stage: "running" as const, stageGeneration: 1,
      group: { id: "00000000-0000-4000-8000-000000000001", rank: 1, size: 2, parallelism: "tensor" as const, rendezvousPort: 29500, generation: 1, addresses: [{ subnet: "192.168.100.0/24", address: "192.168.100.253" }], masterAddress: "192.168.100.254", masterHost: { machineName: "spark-0", address: null } },
    };
    await withDaemon({ ok: true, interconnect: [], groupMembers: [groupMember] }, async (baseUrl) => {
      const { coupling } = await probeDaemonHealth(new FakeHost(), baseUrl, METRICS_AUTH);
      expect(coupling.groupMembers).toEqual([groupMember]);
    });
    await withDaemon({ ok: true }, async (baseUrl) => {
      expect((await probeDaemonHealth(new FakeHost(), baseUrl, METRICS_AUTH)).coupling).toEqual({ interconnect: [], groupMembers: [] });
    });
  });

  test("reports an unreachable daemon", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = closed.port;
    await closed.stop(true);
    const { checks } = await probeDaemonHealth(new FakeHost(), `http://127.0.0.1:${port}`, METRICS_AUTH);

    expect(checks[0]).toMatchObject({ status: "fail", message: "Unreachable" });
  });
});

describe("checkHealthEndpoint", () => {
  test("adds the update hint to a 404 only", async () => {
    const answering = (code: string) => new FakeHost({ run: () => ({ ok: true, output: code }) });

    expect((await checkHealthEndpoint(answering("404"), "Health endpoint", "http://localhost:4121")).detail).toContain("predates /health");
    expect((await checkHealthEndpoint(answering("503"), "Health endpoint", "http://localhost:4121")).detail).toBeUndefined();
  });
});


describe("checkSmtp", () => {
  async function withPlaintextGreeter(run: (port: number) => Promise<void>): Promise<void> {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.write("220 mail.example ESMTP\r\n");
        },
        data() {},
      },
    });
    try {
      await run(server.port);
    } finally {
      server.stop(true);
    }
  }

  test("reads the greeting of an smtp:// server in plaintext", async () => {
    await withPlaintextGreeter(async (port) => {
      const check = await checkSmtp(`smtp://127.0.0.1:${port}`, new FakeHost());

      expect(check).toMatchObject({ status: "pass", message: "SMTP server reachable" });
    });
  });

  test("speaks TLS first to an smtps:// server", async () => {
    await withPlaintextGreeter(async (port) => {
      const check = await checkSmtp(`smtps://127.0.0.1:${port}`, new FakeHost());

      expect(check.status).toBe("warn");
    });
  });
});
