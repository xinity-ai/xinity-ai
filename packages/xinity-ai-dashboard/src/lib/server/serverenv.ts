/**
 * Server-only environment configuration with validation.
 * Fail fast on missing/invalid config and expose a typed `serverEnv`.
 */
import { parseEnv } from "common-env";
import { dashboardEnvSchema } from "./env-schema.ts";

/**
 * Parsed environment variables. Avoid reading from `process.env` elsewhere.
 */
export const serverEnv = parseEnv(dashboardEnvSchema);

/**
 * Check if an email address belongs to an instance admin.
 */
export function isInstanceAdmin(email?: string | null): boolean {
  if (!serverEnv.INSTANCE_ADMIN_EMAILS || !email) return false;
  return serverEnv.INSTANCE_ADMIN_EMAILS.split(",").map(e => e.trim().toLowerCase()).includes(email.toLowerCase());
}

