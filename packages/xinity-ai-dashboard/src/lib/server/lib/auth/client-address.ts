/**
 * Single source of truth for the client IP.
 *
 * The request hook resolves the address once from the raw connection plus the
 * HTTP_IP_HEADER / HTTP_XFF_DEPTH / HTTP_TRUSTED_PROXIES settings, so this module
 * is the only place a forwarded header is trusted. The hook stamps the result onto
 * CLIENT_ADDRESS_HEADER, overwriting anything the client sent, so downstream
 * consumers that only see a Request (Better Auth) read the same value instead of
 * re-parsing x-forwarded-for.
 */
import { BlockList, isIPv6 } from "node:net";
import type { TrustingProxyConfig } from "common-env";

export const CLIENT_ADDRESS_HEADER = "x-client-address";

function trustedProxyList(entries: string[]): BlockList | null {
  if (entries.length === 0) {
    return null;
  }
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split("/");
    const family = isIPv6(address!) ? "ipv6" : "ipv4";
    if (prefix === undefined) {
      list.addAddress(address!, family);
    } else {
      list.addSubnet(address!, Number(prefix), family);
    }
  }
  return list;
}

/** The socket address is undefined over a unix socket. */
export function createClientAddressResolver(
  proxy: TrustingProxyConfig,
): (request: Request, socketAddress: string | undefined) => string {
  const header = proxy.header?.toLowerCase();
  const trusted = trustedProxyList(proxy.trustedProxies);
  const fromTrustedProxy = (socketAddress: string | undefined) =>
    !trusted || (!!socketAddress && trusted.check(socketAddress, isIPv6(socketAddress) ? "ipv6" : "ipv4"));

  return (request, socketAddress) => {
    const fallback = socketAddress ?? "";
    if (!header || !fromTrustedProxy(socketAddress)) {
      return fallback;
    }
    const value = request.headers.get(header);
    if (value === null) {
      return fallback;
    }
    if (header !== "x-forwarded-for") {
      return value.trim() || fallback;
    }
    return value.split(",").at(-proxy.xffDepth)?.trim() || fallback;
  };
}

export function stampClientAddress(request: Request, address: string): void {
  if (address) {
    request.headers.set(CLIENT_ADDRESS_HEADER, address);
  } else {
    request.headers.delete(CLIENT_ADDRESS_HEADER);
  }
}

export function readClientAddress(headers: Headers | null | undefined): string | null {
  return headers?.get(CLIENT_ADDRESS_HEADER) || null;
}
