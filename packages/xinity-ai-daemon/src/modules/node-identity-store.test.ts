import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, readNodeId, rotateIdentity } from "./node-identity-store";

const stateDir = mkdtempSync(join(tmpdir(), "xinity-node-identity-test-"));
const idFile = join(stateDir, "node_id");
const keyFile = join(stateDir, "node_key");
const EXISTING_ID = "3f1a2b3c-0000-4000-8000-00000000dead";

describe("loadOrCreateIdentity", () => {
  beforeEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await mkdir(stateDir, { recursive: true });
  });
  afterAll(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  test("keeps the identity across restarts", async () => {
    const first = await loadOrCreateIdentity(stateDir);
    const second = await loadOrCreateIdentity(stateDir);

    expect(second.nodeId).toBe(first.nodeId);
    expect(second.keypair.publicKey).toBe(first.keypair.publicKey);
  });

  test("a node id with no key keeps the id and gets a key", async () => {
    await Bun.write(idFile, EXISTING_ID);

    const identity = await loadOrCreateIdentity(stateDir);

    expect(identity.nodeId).toBe(EXISTING_ID);
    expect((await loadOrCreateIdentity(stateDir)).keypair.publicKey).toBe(identity.keypair.publicKey);
  });

  test("a corrupt key is treated as a missing one", async () => {
    await Bun.write(idFile, EXISTING_ID);
    await Bun.write(keyFile, "not a key");

    const identity = await loadOrCreateIdentity(stateDir);

    expect(identity.nodeId).toBe(EXISTING_ID);
    expect((await loadOrCreateIdentity(stateDir)).keypair.publicKey).toBe(identity.keypair.publicKey);
  });

  test("a key with no id is not adopted", async () => {
    const { keypair } = await loadOrCreateIdentity(stateDir);
    await rm(idFile);

    expect((await loadOrCreateIdentity(stateDir)).keypair.publicKey).not.toBe(keypair.publicKey);
  });

  test("a rotated identity replaces both the id and the key", async () => {
    const before = await loadOrCreateIdentity(stateDir);

    const rotated = await rotateIdentity(stateDir);

    expect(rotated.nodeId).not.toBe(before.nodeId);
    expect(rotated.keypair.publicKey).not.toBe(before.keypair.publicKey);
    expect(await readNodeId(stateDir)).toBe(rotated.nodeId);
    expect((await loadOrCreateIdentity(stateDir)).keypair.publicKey).toBe(rotated.keypair.publicKey);
  });
});
