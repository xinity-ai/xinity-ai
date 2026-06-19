import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "node:fs/promises";

const STATE_DIR = "/tmp/xinity-statekeeper-test";

// Mock env to avoid parseEnv side-effect (requires DB_CONNECTION_URL etc. in CI).
mock.module("../env", () => ({ env: {
  PORT: 4044,
  HOST: "0.0.0.0",
  STATE_DIR,
  CIDR_PREFIX: "",
  DB_CONNECTION_URL: "postgres://localhost/test",
  INFOSERVER_URL: "http://localhost:19090",
  LOG_LEVEL: "silent",
}}));

const { readNodeIdFile } = await import("./statekeeper");

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
