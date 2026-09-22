import { test, expect, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockConfigModule } from "../mock-config";
import { canonicalStateReport, KEEPALIVE_INTERVAL_HEADER, readNodeKeypair, verifyNodeSignature, type NodeRegistration, type UnsignedInstallationStateReport } from "common-env";

const stateDir = mkdtempSync(join(tmpdir(), "tether-client-test-"));

// The trailing slash is the shape that produced `//api/v1/stream` in production.
mock.module("../config", () => mockConfigModule({ TETHER_URL: "http://100.64.0.11:2000/", STATE_DIR: stateDir }));

const { reportInstallationStates, connectSSE } = await import("./tether-client");
const { config } = await import("../config");

async function captureStatusPost(report: UnsignedInstallationStateReport) {
  const requested: string[] = [];
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    requested.push(String(input));
    bodies.push(String(init?.body ?? ""));
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;

  try {
    await reportInstallationStates(report);
  } finally {
    globalThis.fetch = realFetch;
  }
  return { requested, bodies };
}

test("tether endpoints ignore a trailing slash on TETHER_URL", async () => {
  const { requested } = await captureStatusPost({ nodeId: "node-1", states: [] });

  expect(requested).toEqual(["http://100.64.0.11:2000/api/v1/status"]);
});

test("a status report is signed by the node key the tether pins", async () => {
  const report: UnsignedInstallationStateReport = {
    nodeId: "node-1",
    states: [{ installationId: "inst-1", lifecycleState: "ready" }],
  };
  const { bodies } = await captureStatusPost(report);

  const { signature } = JSON.parse(bodies[0]!) as { signature: string };
  const keypair = readNodeKeypair(await Bun.file(join(stateDir, "node_key")).text());

  expect(verifyNodeSignature(keypair!.publicKey, canonicalStateReport(report), signature)).toBe(true);
});

// Last in the file: the generator has no stop signal, so its reconnect loop outlives the test.
test("a stream that stays silent past the announced keepalive is reopened", async () => {
  let connects = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      connects++;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": hello\n\n"));
        },
      });
      return new Response(stream, { headers: { [KEEPALIVE_INTERVAL_HEADER]: "20" } });
    },
  });
  config.tether.url = server.url.href;

  void connectSSE({} as NodeRegistration).next();
  const deadline = Date.now() + 3000;
  while (connects < 2 && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  await server.stop(true);

  expect(connects).toBeGreaterThanOrEqual(2);
});
