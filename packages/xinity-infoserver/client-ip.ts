/**
 * Resolves the address a request originated from. Behind a proxy the socket
 * address is the proxy's, so the client has to be read out of a forwarding
 * header, and such a header is only trustworthy as deep as the proxy chain
 * actually is: a client can pre-seed entries, and the proxies append after them.
 */

export interface SocketAddressSource {
  requestIP(req: Request): { address: string } | null;
}

export interface ClientIpConfig {
  /** Forwarding header to read. Unset means trust only the socket address. */
  header: string | undefined;
  /** Number of proxies in front. Entries left of that position are client-supplied. */
  xffDepth: number;
}

export function resolveClientIp(
  req: Request,
  server: SocketAddressSource,
  config: ClientIpConfig,
): string {
  const socketAddress = server.requestIP(req)?.address ?? "unknown";
  if (!config.header || config.xffDepth < 1) {
    return socketAddress;
  }

  const forwarded = req.headers.get(config.header);
  if (!forwarded) {
    return socketAddress;
  }

  const entries = forwarded.split(",").map(entry => entry.trim()).filter(Boolean);
  // Counted from the right, where the nearest trusted proxy writes.
  const trusted = entries[Math.max(0, entries.length - config.xffDepth)];
  return trusted ?? socketAddress;
}
