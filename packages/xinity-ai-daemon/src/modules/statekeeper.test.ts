import { describe, test, expect, afterAll, mock } from "bun:test";
import { mockConfigModule } from "../mock-config";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Unique per process: concurrent runs must not share this directory.
const STATE_DIR = mkdtempSync(join(tmpdir(), "xinity-statekeeper-test-"));

let ollamaHealthy = true;
const ollama = Bun.serve({
  port: 0,
  fetch: (req) =>
    new URL(req.url).pathname === "/api/version" && ollamaHealthy
      ? Response.json({ version: "0.12.3" })
      : new Response("unavailable", { status: 500 }),
});

mock.module("../config", () => mockConfigModule({ STATE_DIR, OLLAMA_URL: `http://127.0.0.1:${ollama.port}` }));

const { getNodeDrivers, getNodeDriverVersions } = await import("./statekeeper");

afterAll(async () => {
  await rm(STATE_DIR, { recursive: true, force: true });
});

// The registration reports drivers once, so the driver list must keep the first
// probe's answer. Tests run in order: each one degrades the endpoint further.
describe("getNodeDrivers", () => {
  afterAll(() => ollama.stop(true));

  test("lists ollama when the endpoint answers the first probe", async () => {
    expect(await getNodeDrivers()).toEqual(["ollama"]);
    expect(await getNodeDriverVersions()).toEqual({ ollama: "0.12.3" });
  });

  test("keeps ollama after the endpoint starts rejecting", async () => {
    ollamaHealthy = false;
    expect(await getNodeDrivers()).toEqual(["ollama"]);
    expect(await getNodeDriverVersions()).toEqual({ ollama: "0.12.3" });
  });

  test("keeps ollama after nothing is listening", async () => {
    await ollama.stop(true);
    expect(await getNodeDrivers()).toEqual(["ollama"]);
  });
});
