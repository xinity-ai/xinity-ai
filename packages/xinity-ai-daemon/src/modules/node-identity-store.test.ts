import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, readNodeId } from "./node-identity-store";

const stateDir = mkdtempSync(join(tmpdir(), "xinity-node-identity-test-"));
const idFile = join(stateDir, "node_id");
const keyFile = join(stateDir, "node_key");

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

  test("a node id whose key is gone becomes a new node rather than reclaiming the id", async () => {
    await Bun.write(idFile, "3f1a2b3c-0000-4000-8000-00000000dead");

    const identity = await loadOrCreateIdentity(stateDir);

    expect(identity.nodeId).not.toBe("3f1a2b3c-0000-4000-8000-00000000dead");
    expect(await readNodeId(stateDir)).toBe(identity.nodeId);
  });

  test("a corrupt key is treated as a missing one", async () => {
    await Bun.write(idFile, "3f1a2b3c-0000-4000-8000-00000000dead");
    await Bun.write(keyFile, "not a key");

    expect((await loadOrCreateIdentity(stateDir)).nodeId).not.toBe("3f1a2b3c-0000-4000-8000-00000000dead");
  });

  test("a key with no id is not adopted", async () => {
    const { keypair } = await loadOrCreateIdentity(stateDir);
    await rm(idFile);

    expect((await loadOrCreateIdentity(stateDir)).keypair.publicKey).not.toBe(keypair.publicKey);
  });
});
