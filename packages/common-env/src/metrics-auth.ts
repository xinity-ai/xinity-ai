/**
 * Shared METRICS_AUTH handling: a comma-separated list of user:pass pairs
 * (e.g. "admin:secret,reader:abc123"); empty/unset leaves the endpoint open.
 */

import { z } from "zod";

const BASIC_PREFIX = "Basic ";

export type MetricsCredential = { user: string; pass: string };

/** Split "user:pass" on the first colon, so passwords may contain colons. */
function parseUserPass(value: string): MetricsCredential | null {
  const sep = value.indexOf(":");
  if (sep === -1) return null;
  return { user: value.slice(0, sep), pass: value.slice(sep + 1) };
}

/**
 * Env-schema field validating METRICS_AUTH's user:pass[,…] format at parse time.
 * Kept a string (not transformed) so the CLI's schema introspection still works.
 * `required: true` rejects unset/empty for endpoints that must never be anonymous.
 */
export function metricsAuthSchema(opts: { required?: boolean } = {}) {
  const validate = (value: string | undefined): boolean => {
    try {
      parseMetricsAuth(value);
      return true;
    } catch {
      return false;
    }
  };
  const message = 'METRICS_AUTH must be "user:pass", comma-separated for multiple pairs';
  return opts.required
    ? z.string().min(1).refine(validate, { message })
    : z.string().optional().refine(validate, { message });
}

/** Parse METRICS_AUTH into credentials. Throws on a malformed entry so misconfiguration fails fast. */
export function parseMetricsAuth(raw: string | undefined): MetricsCredential[] {
  if (!raw) return [];
  return raw.split(",").map((pair) => {
    const parsed = parseUserPass(pair);
    if (!parsed) throw new Error(`Invalid METRICS_AUTH entry (missing ':'): "${pair}"`);
    return parsed;
  });
}

export function authHeaderMatches(
  credentials: MetricsCredential[],
  authHeader: string | null | undefined,
): boolean {
  if (!authHeader?.startsWith(BASIC_PREFIX)) return false;
  let decoded: string;
  try {
    decoded = atob(authHeader.slice(BASIC_PREFIX.length));
  } catch {
    return false;
  }
  const sent = parseUserPass(decoded);
  if (!sent) return false;
  return credentials.some((c) => c.user === sent.user && c.pass === sent.pass);
}

export type MetricsAuth = {
  credentials: MetricsCredential[];
  /** Open when no credentials are configured, else requires a matching header. */
  isAuthorized: (authHeader: string | null | undefined) => boolean;
  /** 401 Response when unauthorized, null when allowed. */
  unauthorized: (authHeader: string | null | undefined) => Response | null;
};

export function createMetricsAuth(raw: string | undefined): MetricsAuth {
  const credentials = parseMetricsAuth(raw);
  const isAuthorized = (authHeader: string | null | undefined): boolean =>
    credentials.length === 0 || authHeaderMatches(credentials, authHeader);
  return {
    credentials,
    isAuthorized,
    unauthorized: (authHeader) =>
      isAuthorized(authHeader)
        ? null
        : new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="metrics"' },
          }),
  };
}
