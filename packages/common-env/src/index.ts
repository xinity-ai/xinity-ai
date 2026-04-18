/**
 * Unified environment variable parsing with secret file support.
 *
 * For any env var KEY, you can alternatively set KEY_FILE to a file path
 * whose trimmed contents will be used as the value. Direct env vars take
 * precedence over _FILE variants.
 *
 * Usage:
 *   const env = parseEnv(z.object({ DB_CONNECTION_URL: z.url(), ... }));
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * For each key, check if a corresponding KEY_FILE env var is set.
 * If so (and KEY itself is not set), read the file and use its trimmed
 * contents as the value. Returns a new env record with resolved values.
 */
function resolveSecretFiles(
  env: Record<string, string | undefined>,
  keys: string[],
): Record<string, string | undefined> {
  const resolved: Record<string, string | undefined> = {};

  for (const key of keys) {
    if (env[key] !== undefined && env[key] !== "") {
      resolved[key] = env[key];
      continue;
    }

    const fileKey = `${key}_FILE`;
    const filePath = env[fileKey];
    if (filePath) {
      try {
        resolved[key] = readFileSync(filePath, "utf-8").trim();
      } catch (err) {
        throw new Error(
          `Failed to read secret file for ${key} from "${filePath}": ${(err as Error).message}`,
        );
      }
    }
  }

  return { ...env, ...resolved };
}

type ZodObjectWithShape = z.ZodType & { shape: Record<string, unknown> };

/**
 * Parse environment variables through a Zod object schema with _FILE secret
 * support. Each key in the schema can be provided either directly or via a
 * KEY_FILE env var pointing to a file containing the value.
 */
/**
 * Zod `.meta()` marker for env vars that should be treated as secrets.
 * Used by the CLI to decide which values go into LoadCredential files
 * vs. the plain EnvironmentFile.
 *
 * Usage: `DB_CONNECTION_URL: z.url().meta(secret())`
 */
export function secret() {
  return { secret: true as const };
}

/**
 * Zod `.meta()` marker for env vars that are expert/advanced settings.
 * Fields without this marker are considered essential. Used by the CLI
 * and dashboard to separate basic setup from advanced tuning.
 *
 * Usage: `BACKEND_TIMEOUT_MS: z.coerce.number().meta(expert())`
 */
export function expert() {
  return { expert: true as const };
}

/**
 * Zod `.meta()` marker for env vars that should be forwarded to the client
 * via SvelteKit layout data. These fields are read on the server and passed
 * through as layout data, then made available via `getClientEnv()` in
 * Svelte components. Values must be safe to expose to the browser.
 *
 * Usage: `GATEWAY_URL: z.url().meta(clientPublic())`
 */
export function clientPublic() {
  return { public: true as const };
}

export function parseEnv<T extends ZodObjectWithShape>(
  schema: T,
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): z.infer<T> {
  const keys = Object.keys(schema.shape);
  const resolved = resolveSecretFiles(env, keys);
  return schema.parse(resolved);
}

/**
 * Reusable TLS env vars for opt-in HTTPS on any service.
 * Extend your service's env schema with `.extend(tlsEnvSchema.shape)`.
 */
export const tlsEnvSchema = z.object({
  XINITY_TLS_CERT: z.string().optional()
    .describe("PEM-encoded TLS certificate (enables HTTPS). See docs/security/mtls.md")
    .meta(secret()),
  XINITY_TLS_KEY: z.string().optional()
    .describe("PEM-encoded TLS private key (enables HTTPS). See docs/security/mtls.md")
    .meta(secret()),
});

/** Returns `{ cert, key }` if TLS is fully configured, `undefined` otherwise. Throws on partial config. */
export function parseTlsConfig(env: { XINITY_TLS_CERT?: string; XINITY_TLS_KEY?: string }) {
  const hasCert = !!env.XINITY_TLS_CERT;
  const hasKey = !!env.XINITY_TLS_KEY;
  if (hasCert !== hasKey) {
    throw new Error("XINITY_TLS_CERT and XINITY_TLS_KEY must both be set or both be unset");
  }
  if (!hasCert) return undefined;
  return { cert: env.XINITY_TLS_CERT!, key: env.XINITY_TLS_KEY! };
}
