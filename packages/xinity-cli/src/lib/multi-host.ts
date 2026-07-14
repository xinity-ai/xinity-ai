import { log } from "./clack.ts";
import { type Host } from "./host.ts";
import { connectHost } from "./remote-host.ts";
import { heading } from "./output.ts";

/**
 * Connect and establish root privileges on every address up front, so the
 * flows that follow never stop for authentication. Returns null (after
 * cleanup) when a connection fails or elevation is declined.
 */
export async function connectHosts(addresses: string[]): Promise<Map<string, Host> | null> {
  const hosts = new Map<string, Host>();
  for (const addr of addresses) {
    try {
      const host = await connectHost(addr === "local" ? undefined : addr);
      hosts.set(addr, host);
      if (!(await host.prepareElevation())) {
        log.error(`Root privileges on ${addr} were declined`);
        await disposeAll(hosts);
        return null;
      }
    } catch (err) {
      log.error(`Could not connect to ${addr}: ${(err as Error).message}`);
      await disposeAll(hosts);
      return null;
    }
  }
  return hosts;
}

/** Run an action per host under its own heading; an error is reported and the loop continues. */
export async function forEachHost(
  hosts: Map<string, Host>,
  action: (host: Host, address: string) => Promise<void>,
): Promise<void> {
  for (const [address, host] of hosts) {
    heading(address);
    try {
      await action(host, address);
    } catch (err) {
      log.error(`${address}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function disposeAll(hosts: Map<string, Host>): Promise<void> {
  await Promise.allSettled([...hosts.values()].map((host) => host.dispose()));
}
