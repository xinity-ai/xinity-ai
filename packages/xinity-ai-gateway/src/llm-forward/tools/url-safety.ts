import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIPv4 } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "url-safety" });

const BLOCKED_IPV4_SUBNETS: [string, number][] = [
  ["0.0.0.0", 8],       // Current network
  ["10.0.0.0", 8],      // RFC 1918
  ["100.64.0.0", 10],   // Carrier-grade NAT (RFC 6598)
  ["127.0.0.0", 8],     // Loopback
  ["169.254.0.0", 16],  // Link-local, cloud metadata
  ["172.16.0.0", 12],   // RFC 1918
  ["192.0.0.0", 24],    // IETF protocol assignments
  ["192.0.2.0", 24],    // TEST-NET-1
  ["192.168.0.0", 16],  // RFC 1918
  ["198.18.0.0", 15],   // Benchmarking (RFC 2544)
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24],  // TEST-NET-3
  ["224.0.0.0", 4],     // Multicast
  ["240.0.0.0", 4],     // Reserved, broadcast
];

const BLOCKED_IPV6_SUBNETS: [string, number][] = [
  ["::", 96],     // Unspecified, loopback, deprecated IPv4-compatible
  ["fc00::", 7],  // Unique-local (RFC 4193)
  ["fe80::", 10], // Link-local
  ["fec0::", 10], // Site-local (deprecated)
  ["ff00::", 8],  // Multicast
];

/** The last 32 bits of these prefixes are an IPv4 address that the IPv4 rules must judge. */
const IPV4_EMBEDDING_PREFIXES = [
  [0, 0, 0, 0, 0, 0xffff], // IPv4-mapped (::ffff:0:0/96)
  [0x64, 0xff9b, 0, 0, 0, 0], // NAT64 well-known prefix (64:ff9b::/96)
];

function subnetBlockList(subnets: [string, number][], type: "ipv4" | "ipv6"): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of subnets) {
    list.addSubnet(network, prefix, type);
  }
  return list;
}

const blockedIpv4 = subnetBlockList(BLOCKED_IPV4_SUBNETS, "ipv4");
const blockedIpv6 = subnetBlockList(BLOCKED_IPV6_SUBNETS, "ipv6");

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
  return blockedIpv4.check(ip, "ipv4") ? `Blocked IP range: ${ip}` : null;
}

/** URL serialisation turns every IPv6 spelling, a dotted IPv4 tail included, into compressed hex. */
function ipv6Groups(ip: string): number[] {
  const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  const [head, tail] = canonical.split("::");
  const groups = (part: string | undefined) => (part ? part.split(":").map((group) => parseInt(group, 16)) : []);
  if (tail === undefined) {
    return groups(head);
  }
  const headGroups = groups(head);
  const tailGroups = groups(tail);
  return [...headGroups, ...Array.from({ length: 8 - headGroups.length - tailGroups.length }, () => 0), ...tailGroups];
}

function isBlockedIpv6(ip: string): string | null {
  let groups: number[];
  try {
    groups = ipv6Groups(ip);
  } catch {
    return `Unparseable IPv6 address: ${ip}`;
  }

  if (IPV4_EMBEDDING_PREFIXES.some((prefix) => prefix.every((group, i) => groups[i] === group))) {
    const [high = 0, low = 0] = groups.slice(6);
    return isBlockedIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
  }

  return blockedIpv6.check(ip, "ipv6") ? `Blocked IPv6 range: ${ip}` : null;
}

type ResolvedAddresses = { addresses: LookupAddress[] } | { blocked: string };

export async function resolvePublicAddresses(hostname: string): Promise<ResolvedAddresses> {
  if (isIPv4(hostname)) {
    return { addresses: [{ address: hostname, family: 4 }] };
  }

  let addresses: LookupAddress[];
  try {
    // The system resolver, unlike resolve4/resolve6, also answers from /etc/hosts.
    addresses = await lookup(hostname, { all: true });
  } catch (err) {
    log.debug({ err, hostname }, "Hostname lookup failed");
    return { blocked: `Could not resolve ${hostname}` };
  }
  if (addresses.length === 0) {
    return { blocked: `${hostname} resolved to no addresses` };
  }

  for (const { address, family } of addresses) {
    const blocked = family === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address);
    if (blocked) return { blocked };
  }

  return { addresses };
}

export function fetchPinned(url: URL, { address, family }: LookupAddress, init: BunFetchRequestInit & { headers?: Record<string, string> }): Promise<Response> {
  // Resolving the hostname a second time would let a rebinding DNS server answer differently than it did for the check.
  const pinned = new URL(url);
  pinned.hostname = family === 6 ? `[${address}]` : address;
  const { hostname } = url;
  return fetch(pinned, {
    ...init,
    headers: { ...init.headers, host: url.host },
    tls: {
      ...init.tls,
      serverName: hostname,
      checkServerIdentity: (_pinnedHost: string, cert: PeerCertificate) => checkServerIdentity(hostname, cert),
    },
  });
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

  return isIPv4(bare) ? isBlockedIpv4(bare) : null;
}

async function fetchFirstReachable(
  url: URL,
  addresses: LookupAddress[],
  init: BunFetchRequestInit & { headers: Record<string, string>; signal: AbortSignal },
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await fetchPinned(url, address, init);
    } catch (err) {
      if (init.signal.aborted) {
        throw new Error(`Fetch timed out after ${timeoutMs}ms`, { cause: err });
      }
      log.debug({ err, url: url.toString(), address: address.address }, "Pinned address unreachable, trying the next one");
      lastError = err;
    }
  }
  throw lastError;
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

    const url = new URL(currentUrl);
    const resolved = await resolvePublicAddresses(url.hostname);
    if ("blocked" in resolved) {
      log.warn({ url: currentUrl, reason: resolved.blocked }, "Blocked outbound request (resolved address)");
      throw new Error(`URL blocked: ${resolved.blocked}`);
    }

    const response = await fetchFirstReachable(url, resolved.addresses, { signal, headers, redirect: "manual" }, timeoutMs);

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }
}
