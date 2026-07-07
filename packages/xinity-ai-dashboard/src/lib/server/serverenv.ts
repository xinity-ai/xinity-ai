/**
 * Server-only environment configuration with validation.
 * Fail fast on missing/invalid config and expose a typed `serverEnv`.
 */
import { parseEnv } from "common-env";
import { dashboardEnvSchema } from "./env-schema";

export const serverEnv = parseEnv(dashboardEnvSchema, process.env);

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

