import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "url-safety" });

/**
 * Blocked IP ranges for SSRF protection.
 * Covers private networks, loopback, link-local, and cloud metadata endpoints.
 */
const BLOCKED_IP_PATTERNS = [
  /^127\./,                          // IPv4 loopback
  /^10\./,                           // RFC 1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\./,     // RFC 1918 Class B
  /^192\.168\./,                     // RFC 1918 Class C
  /^169\.254\./,                     // Link-local
  /^0\./,                            // Current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // Carrier-grade NAT (RFC 6598)
  /^198\.1[89]\./,                   // Benchmarking (RFC 2544)
  /^192\.0\.0\./,                    // IETF Protocol Assignments
  /^192\.0\.2\./,                    // Documentation (TEST-NET-1)
  /^198\.51\.100\./,                 // Documentation (TEST-NET-2)
  /^203\.0\.113\./,                  // Documentation (TEST-NET-3)
  /^224\./,                          // Multicast
  /^240\./,                          // Reserved
  /^255\.255\.255\.255$/,            // Broadcast
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".internal",
  ".local",
  ".localhost",
];

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export type SafeFetchOptions = {
  /** Timeout in milliseconds. Defaults to 15s. */
  timeoutMs?: number;
  /** Additional headers to include. */
  headers?: Record<string, string>;
};

/**
 * Validates a URL against SSRF blocklists.
 * Returns an error message if the URL is blocked, or null if it's safe.
 */
export function validateUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "Invalid URL";
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return `Blocked protocol: ${parsed.protocol}`;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return `Blocked hostname: ${hostname}`;
  }

  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return `Blocked hostname: ${hostname}`;
    }
  }

  // Check if hostname is an IP address
  // Strip brackets from IPv6
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  // Block all IPv6 addresses (too many bypass vectors via ::1, ::ffff:127.0.0.1, etc.)
  if (bare.includes(":")) {
    return "IPv6 addresses are not allowed";
  }

  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(bare)) {
      return `Blocked IP range: ${bare}`;
    }
  }

  return null;
}

/**
 * Fetch a URL with SSRF protection and timeout.
 * Throws on blocked URLs, timeouts, and HTTP errors.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const error = validateUrl(rawUrl);
  if (error) {
    log.warn({ url: rawUrl, reason: error }, "Blocked outbound request");
    throw new Error(`URL blocked: ${error}`);
  }

  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, headers = {} } = options;
  try {
    return await fetch(rawUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      redirect: "follow",
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`Fetch timed out after ${timeoutMs}ms`);
    }
    throw e;
  }
}
