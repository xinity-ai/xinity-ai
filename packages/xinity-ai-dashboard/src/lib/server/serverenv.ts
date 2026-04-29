/**
 * Server-only environment configuration with validation.
 * Fail fast on missing/invalid config and expose a typed `serverEnv`.
 */
import { parseEnv } from "common-env";
import { dashboardEnvSchema } from "./env-schema.ts";

/**
 * Parsed environment variables. Avoid reading from `process.env` elsewhere.
 */
const rawEnv = { ...process.env } as Record<string, string | undefined>;
// Backwards compat: migrate PUBLIC_LLM_API_URL to GATEWAY_URL.
// The old variable conventionally included a trailing /v1; the new one does not.
// Strip it so values copied verbatim still produce a correct GATEWAY_URL.
if (!rawEnv.GATEWAY_URL && rawEnv.PUBLIC_LLM_API_URL) {
  // We have to use console here, as the logging module is not yet able to load
  console.warn("PUBLIC_LLM_API_URL is depricated and will be removed in 1.0.0. Change the variable to GATEWAY_URL (without the /v1 suffix)")
  rawEnv.GATEWAY_URL = rawEnv.PUBLIC_LLM_API_URL.replace(/\/v1\/?$/, "");
}
// Defensive normalization: GATEWAY_URL must not include /v1; warn and strip
// so a misconfigured deployment fails loudly rather than 404ing on every
// request that builds `${GATEWAY_URL}/v1/...`.
if (rawEnv.GATEWAY_URL && /\/v1\/?$/.test(rawEnv.GATEWAY_URL)) {
  console.warn("GATEWAY_URL must not end with /v1 - the /v1 segment is appended by the dashboard where needed. Stripping for compatibility, but please update your configuration.");
  rawEnv.GATEWAY_URL = rawEnv.GATEWAY_URL.replace(/\/v1\/?$/, "");
}

export const serverEnv = parseEnv(dashboardEnvSchema, rawEnv);

/**
 * Check if an email address belongs to an instance admin.
 */
export function isInstanceAdmin(email?: string | null): boolean {
  if (!serverEnv.INSTANCE_ADMIN_EMAILS || !email) return false;
  return serverEnv.INSTANCE_ADMIN_EMAILS.split(",").map(e => e.trim().toLowerCase()).includes(email.toLowerCase());
}

