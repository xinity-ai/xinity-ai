import { generateNodeKeypair, readNodeKeypair, type NodeKeypair } from "common-env";
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

async function readKeypair(stateDir: string): Promise<NodeKeypair | null> {
  const keyFile = Bun.file(join(stateDir, "node_key"));
  if (!(await keyFile.exists())) {
    return null;
  }
  return readNodeKeypair(await keyFile.text());
}

async function writeIdentity(stateDir: string, nodeId: string): Promise<NodeIdentity> {
  const identity: NodeIdentity = { nodeId, keypair: generateNodeKeypair() };
  await Bun.write(join(stateDir, "node_key"), identity.keypair.privateKeyPem, { mode: 0o600 });
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
