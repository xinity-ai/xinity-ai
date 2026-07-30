import { randomBytes } from "node:crypto";

/** Shortening these breaks the assumption behind apiKeyVerifier. */
const SPECIFIER_BYTES = 16;
const SECRET_BYTES = 64;

function generateRandomKey(length: number) {
  return randomBytes(length).toString("base64url");
}

export function generateApiKey() {
  const specifier = "sk_" + generateRandomKey(SPECIFIER_BYTES);
  return { specifier, fullKey: specifier + generateRandomKey(SECRET_BYTES) };
}
