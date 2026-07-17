import { log } from "./clack.ts";
import { type Host } from "./host.ts";
import { connectHost } from "./remote-host.ts";

export async function connectElevated(
  address: string,
): Promise<{ host: Host } | { failed: "unreachable" | "declined"; message: string }> {
  try {
    const host = await connectHost(address === "local" ? undefined : address);
    if (await host.prepareElevation()) {
      return { host };
    }
    await host.dispose();
    return { failed: "declined", message: `Root privileges on ${address} were declined` };
  } catch (err) {
    return { failed: "unreachable", message: `Could not connect to ${address}: ${(err as Error).message}` };
  }
}

/**
 * Connect and establish root privileges on every address up front, so the
 * flows that follow never stop for authentication. Returns null (after
 * cleanup) when a connection fails or elevation is declined.
 */
export async function connectHosts(addresses: string[]): Promise<Map<string, Host> | null> {
  const hosts = new Map<string, Host>();
  for (const addr of addresses) {
    const connection = await connectElevated(addr);
    if ("failed" in connection) {
      log.error(connection.message);
      await disposeAll(hosts);
      return null;
    }
    hosts.set(addr, connection.host);
  }
  return hosts;
}

export async function disposeAll(hosts: Map<string, Host>): Promise<void> {
  await Promise.allSettled([...hosts.values()].map((host) => host.dispose()));
}

/** How many hosts are worked on at once wherever host operations run in parallel. */
export const HOST_CONCURRENCY = 8;

/** Map over items with at most `limit` calls in flight; results keep item order. */
export async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
