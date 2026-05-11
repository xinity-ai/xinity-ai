/**
 * Server-only environment configuration with validation.
 * Fail fast on missing/invalid config and expose a typed `serverEnv`.
 */
import { parseEnv } from "common-env";
import { dashboardEnvSchema } from "./env-schema";

/**
 * Parsed environment variables. Avoid reading from `process.env` elsewhere.
 */
type RawEnv = Record<string, string | undefined>;

const TRAILING_V1_SEGMENT = /\/v1\/?$/;

function normalizeGatewayUrl(env: RawEnv): void {
  if (!env.GATEWAY_URL) return;
  let url = env.GATEWAY_URL;
  if (TRAILING_V1_SEGMENT.test(url)) {
    console.warn("GATEWAY_URL must not end with /v1 - the /v1 segment is appended by the dashboard where needed. Stripping for compatibility, but please update your configuration.");
    url = url.replace(TRAILING_V1_SEGMENT, "");
  }
  env.GATEWAY_URL = url.replace(/\/$/, "");
}

const rawEnv: RawEnv = { ...process.env };
normalizeGatewayUrl(rawEnv);

export const serverEnv = parseEnv(dashboardEnvSchema, rawEnv);

/** Parse a comma-separated env value into a trimmed, non-empty list. */
export function parseCsvEnvList(value: string | undefined | null): string[] {
  return value?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
}

const instanceAdminEmails = new Set(
  parseCsvEnvList(serverEnv.INSTANCE_ADMIN_EMAILS).map(e => e.toLowerCase()),
);

/**
 * Check if an email address belongs to an instance admin.
 */
export function isInstanceAdmin(email?: string | null): boolean {
  if (!email || instanceAdminEmails.size === 0) return false;
  return instanceAdminEmails.has(email.toLowerCase());
}

