/**
 * Server-only environment configuration with validation.
 * Fail fast on missing/invalid config and expose a typed `serverEnv`.
 */
import { parseEnv } from "common-env";
import { dashboardEnvSchema } from "./env-schema.ts";

/**
 * Parsed environment variables. Avoid reading from `process.env` elsewhere.
 */
type RawEnv = Record<string, string | undefined>;

function migrateLegacyPublicLlmApiUrl(env: RawEnv): void {
  if (env.GATEWAY_URL || !env.PUBLIC_LLM_API_URL) return;
  console.warn("PUBLIC_LLM_API_URL is depricated and will be removed in 1.0.0. Change the variable to GATEWAY_URL (without the /v1 suffix)");
  env.GATEWAY_URL = env.PUBLIC_LLM_API_URL.replace(/\/v1\/?$/, "");
}

function stripV1SuffixFromGatewayUrl(env: RawEnv): void {
  if (!env.GATEWAY_URL || !/\/v1\/?$/.test(env.GATEWAY_URL)) return;
  console.warn("GATEWAY_URL must not end with /v1 - the /v1 segment is appended by the dashboard where needed. Stripping for compatibility, but please update your configuration.");
  env.GATEWAY_URL = env.GATEWAY_URL.replace(/\/v1\/?$/, "");
}

const rawEnv: RawEnv = { ...process.env };
migrateLegacyPublicLlmApiUrl(rawEnv);
stripV1SuffixFromGatewayUrl(rawEnv);

export const serverEnv = parseEnv(dashboardEnvSchema, rawEnv);

/**
 * Check if an email address belongs to an instance admin.
 */
export function isInstanceAdmin(email?: string | null): boolean {
  if (!serverEnv.INSTANCE_ADMIN_EMAILS || !email) return false;
  return serverEnv.INSTANCE_ADMIN_EMAILS.split(",").map(e => e.trim().toLowerCase()).includes(email.toLowerCase());
}

