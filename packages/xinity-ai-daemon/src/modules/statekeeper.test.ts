import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
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

mock.module("../env", () => ({ env: {
  PORT: 4044,
  HOST: "0.0.0.0",
  STATE_DIR,
  CIDR_PREFIX: "",
  TETHER_URL: "http://localhost:4020",
  TETHER_SECRET: "test",
  INFOSERVER_URL: "http://localhost:19090",
  OLLAMA_URL: `http://127.0.0.1:${ollama.port}`,
  VLLM_PATH: undefined,
  VLLM_DOCKER_IMAGE: undefined,
  LOG_LEVEL: "silent",
}}));

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

// Ollama takes no configuration to enable, so the driver list has to follow the
// live endpoint rather than the presence of an env value. Tests run in order:
// the last one takes the endpoint away for good.
describe("getNodeDrivers", () => {
  afterAll(() => ollama.stop(true));

  test("lists ollama while the endpoint answers", async () => {
    ollamaHealthy = true;
    expect(await getNodeDrivers()).toEqual(["ollama"]);
    expect(await getNodeDriverVersions()).toEqual({ ollama: "0.12.3" });
  });

  test("omits ollama when the endpoint rejects the probe", async () => {
    ollamaHealthy = false;
    expect(await getNodeDrivers()).toEqual([]);
    expect(await getNodeDriverVersions()).toEqual({});
  });

  test("omits ollama when nothing is listening", async () => {
    ollamaHealthy = true;
    await ollama.stop(true);
    expect(await getNodeDrivers()).toEqual([]);
  });
});
