import { resolve4, resolve6 } from "node:dns/promises";
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

const MAX_REDIRECTS = 5;

function isBlockedIpv4(ip: string): string | null {
  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(ip)) {
      return `Blocked IP range: ${ip}`;
    }
  }
  return null;
}

function isBlockedIpv6(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (lower === "::1") return `Blocked IPv6 loopback: ${ip}`;
  // fe80: = link-local, fc/fd = unique-local (RFC 4193, the IPv6 equivalent of RFC 1918)
  if (lower.startsWith("fe80:")) return `Blocked IPv6 range: ${ip}`;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return `Blocked IPv6 range: ${ip}`;

  // IPv6 can embed IPv4 as ::ffff:a.b.c.d, which bypasses IPv4 blocklists unless checked
  const v4Mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Mapped?.[1]) return isBlockedIpv4(v4Mapped[1]);

  return null;
}

function isIpv4Literal(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

async function validateResolvedAddresses(hostname: string): Promise<string | null> {
  if (isIpv4Literal(hostname)) return null;

  const [v4Addrs, v6Addrs] = await Promise.all([
    resolve4(hostname).catch(() => [] as string[]),
    resolve6(hostname).catch(() => [] as string[]),
  ]);

  for (const ip of v4Addrs) {
    const blocked = isBlockedIpv4(ip);
    if (blocked) return blocked;
  }

  for (const ip of v6Addrs) {
    const blocked = isBlockedIpv6(ip);
    if (blocked) return blocked;
  }

  return null;
}

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

  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_HOSTNAME_SUFFIXES.some(s => hostname.endsWith(s))) {
    return `Blocked hostname: ${hostname}`;
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

  return isBlockedIpv4(bare);
}

/**
 * Fetch a URL with SSRF protection and timeout.
 * Throws on blocked URLs, timeouts, and HTTP errors.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, headers = {} } = options;
  const signal = AbortSignal.timeout(timeoutMs);

  let currentUrl = rawUrl;
  for (let redirects = 0; ; redirects++) {
    const error = validateUrl(currentUrl);
    if (error) {
      log.warn({ url: currentUrl, reason: error }, "Blocked outbound request");
      throw new Error(`URL blocked: ${error}`);
    }

    const dnsError = await validateResolvedAddresses(new URL(currentUrl).hostname);
    if (dnsError) {
      log.warn({ url: currentUrl, reason: dnsError }, "Blocked outbound request (resolved address)");
      throw new Error(`URL blocked: ${dnsError}`);
    }

    let response: Response;
    try {
      response = await fetch(currentUrl, { signal, headers, redirect: "manual" });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(`Fetch timed out after ${timeoutMs}ms`, { cause: e });
      }
      throw e;
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
      }
      await response.body?.cancel();
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }
}
