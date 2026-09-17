import { test, expect, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockConfigModule } from "../mock-config";
import { canonicalStateReport, readNodeKeypair, verifyNodeSignature, type UnsignedInstallationStateReport } from "common-env";

const stateDir = mkdtempSync(join(tmpdir(), "tether-client-test-"));

// The trailing slash is the shape that produced `//api/v1/stream` in production.
mock.module("../config", () => mockConfigModule({ TETHER_URL: "http://100.64.0.11:2000/", STATE_DIR: stateDir }));

const { reportInstallationStates } = await import("./tether-client");

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
