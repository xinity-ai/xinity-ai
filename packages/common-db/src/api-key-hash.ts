/** Argon2 hashes name their algorithm the same way, so both kinds can share one column. */
export const SHA256_VERIFIER_PREFIX = "$sha256$";

export function hashApiKey(key: string): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

/**
 * A fast digest is safe here only because API keys are long, randomly generated,
 * and never chosen by a user
 */
export function apiKeyVerifier(key: string): string {
  return SHA256_VERIFIER_PREFIX + hashApiKey(key);
}
