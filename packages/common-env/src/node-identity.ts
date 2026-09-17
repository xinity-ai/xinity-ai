import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export type NodeKeypair = { privateKeyPem: string; publicKey: string };

function publicKeyOf(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ format: "der", type: "spki" }).toString("base64url");
}

export function generateNodeKeypair(): NodeKeypair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { privateKeyPem, publicKey: publicKeyOf(privateKeyPem) };
}

/** Null for a corrupt key, so the caller can treat it like a missing one. */
export function readNodeKeypair(privateKeyPem: string): NodeKeypair | null {
  try {
    return { privateKeyPem, publicKey: publicKeyOf(privateKeyPem) };
  } catch {
    return null;
  }
}

export function signAsNode(privateKeyPem: string, payload: string): string {
  return sign(null, Buffer.from(payload), privateKeyPem).toString("base64url");
}

export function verifyNodeSignature(publicKey: string, payload: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64url"),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function keyFingerprint(publicKey: string): string {
  return new Bun.CryptoHasher("sha256").update(publicKey).digest("hex").slice(0, 16);
}
