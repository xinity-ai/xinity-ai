/**
 * Shared METRICS_AUTH handling for every service's /metrics endpoints, so they
 * all interpret the env var the same way: a comma-separated list of user:pass
 * pairs (e.g. "admin:secret,reader:abc123"). An empty/unset value leaves the
 * endpoint open.
 *
 * Services that emit raw `Response`s use `unauthorized()`; framework handlers
 * (e.g. SvelteKit) use the `isAuthorized()` boolean.
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
 * Reusable env-schema field for METRICS_AUTH: an optional string validated as a
 * comma-separated list of user:pass pairs during env parsing, so misconfiguration
 * surfaces with the rest of the env errors rather than at the first request. The
 * value stays a string; runtime parsing is done by createMetricsAuth. Callers add
 * their own .describe()/.meta().
 */
export function metricsAuthSchema() {
  return z
    .string()
    .optional()
    .refine(
      (value) => {
        try {
          parseMetricsAuth(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'METRICS_AUTH must be "user:pass", comma-separated for multiple pairs' },
    );
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

/** Whether an Authorization header carries one of the configured credentials. */
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
  /** Open when no credentials are configured, or the header carries a valid one. */
  isAuthorized: (authHeader: string | null | undefined) => boolean;
  /** A 401 `Response` when unauthorized, or null when allowed (for raw fetch handlers). */
  unauthorized: (authHeader: string | null | undefined) => Response | null;
};

/** Build a /metrics auth guard from a raw METRICS_AUTH value. */
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
