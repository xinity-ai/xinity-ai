import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mockConfigModule } from "../mock-config";
import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
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

const { readNodeIdFile, getNodeDrivers, getNodeDriverVersions } = await import("./statekeeper");

const idFile = join(STATE_DIR, "node_id");

describe("readNodeIdFile", () => {
  beforeEach(async () => {
    await rm(STATE_DIR, { recursive: true, force: true });
    await mkdir(STATE_DIR, { recursive: true });
  });
  afterAll(async () => {
    await rm(STATE_DIR, { recursive: true, force: true });
  });

  test("returns null when the file does not exist", async () => {
    expect(await readNodeIdFile()).toBeNull();
  });

  test("returns the trimmed id when present", async () => {
    await Bun.write(idFile, "  3f1a2b3c-0000-4000-8000-000000000001\n");
    expect(await readNodeIdFile()).toBe("3f1a2b3c-0000-4000-8000-000000000001");
  });

  // Guards against feeding an empty string id into the upsert, which would be an
  // invalid uuid: an empty/whitespace file must fall through to (host,port) adoption.
  test("returns null for an empty or whitespace-only file", async () => {
    await Bun.write(idFile, "   \n");
    expect(await readNodeIdFile()).toBeNull();
  });
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
