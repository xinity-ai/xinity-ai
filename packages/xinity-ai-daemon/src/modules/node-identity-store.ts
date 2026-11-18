import { generateNodeKeypair, readNodeKeypair, type NodeKeypair } from "common-env";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type NodeIdentity = { nodeId: string; keypair: NodeKeypair };

export async function readNodeId(stateDir: string): Promise<string | null> {
  const idFile = Bun.file(join(stateDir, "node_id"));
  if (!(await idFile.exists())) {
    return null;
  }
  const id = (await idFile.text()).trim();
  return id.length > 0 ? id : null;
}

const PRIVATE_KEY_MODE = 0o600;

// Earlier versions left the key readable by everyone, so a loaded key is restricted too.
async function readKeypair(stateDir: string): Promise<NodeKeypair | null> {
  const keyPath = join(stateDir, "node_key");
  const keyFile = Bun.file(keyPath);
  if (!(await keyFile.exists())) {
    return null;
  }
  await chmod(keyPath, PRIVATE_KEY_MODE);
  return readNodeKeypair(await keyFile.text());
}

async function writeIdentity(stateDir: string, nodeId: string): Promise<NodeIdentity> {
  const identity: NodeIdentity = { nodeId, keypair: generateNodeKeypair() };
  const keyPath = join(stateDir, "node_key");
  // Bun.write ignores the mode, and writeFile only applies it to a file it creates.
  await writeFile(keyPath, identity.keypair.privateKeyPem, { mode: PRIVATE_KEY_MODE });
  await chmod(keyPath, PRIVATE_KEY_MODE);
  await Bun.file(join(stateDir, "node_id")).write(identity.nodeId);
  return identity;
}

/** An id without a key keeps the id, and the tether decides whether the new key may claim it. */
export async function loadOrCreateIdentity(stateDir: string): Promise<NodeIdentity> {
  const nodeId = await readNodeId(stateDir);
  const keypair = nodeId ? await readKeypair(stateDir) : null;
  if (nodeId && keypair) {
    return { nodeId, keypair };
  }
  return writeIdentity(stateDir, nodeId ?? crypto.randomUUID());
}

export async function rotateIdentity(stateDir: string): Promise<NodeIdentity> {
  return writeIdentity(stateDir, crypto.randomUUID());
}
