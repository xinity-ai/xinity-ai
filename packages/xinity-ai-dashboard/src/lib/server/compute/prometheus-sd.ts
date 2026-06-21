/**
 * Prometheus HTTP service discovery: serves the live node registry as daemon
 * scrape targets, so Prometheus tracks the nodes without a static target list.
 * https://prometheus.io/docs/prometheus/latest/http_sd/
 */
import { getDB } from "$lib/server/db";
import { aiNodeT, isNull } from "common-db";

export type SdNode = {
  id: string;
  host: string;
  port: number;
  tls: boolean;
  machineName: string | null;
};

/** One http_sd target group. Labels apply to every target in the group. */
export type SdGroup = {
  targets: string[];
  labels: Record<string, string>;
};

/** One group per node, so each carries its own scheme and identifying labels. */
export function buildDaemonServiceDiscovery(nodes: SdNode[]): SdGroup[] {
  return nodes.map((node) => {
    const labels: Record<string, string> = {
      __scheme__: node.tls ? "https" : "http",
      node_id: node.id,
    };
    if (node.machineName) labels["machine_name"] = node.machineName;
    return { targets: [`${node.host}:${node.port}`], labels };
  });
}

/** All non-deleted nodes, including offline ones so Prometheus reports them as up==0. */
export async function listDaemonSdNodes(): Promise<SdNode[]> {
  return getDB()
    .select({
      id: aiNodeT.id,
      host: aiNodeT.host,
      port: aiNodeT.port,
      tls: aiNodeT.tls,
      machineName: aiNodeT.machineName,
    })
    .from(aiNodeT)
    .where(isNull(aiNodeT.deletedAt));
}

export type ScrapeTarget = { target: string; scheme: string };

export function scrapeTarget(rawUrl: string): ScrapeTarget {
  const u = new URL(rawUrl);
  const scheme = u.protocol.replace(":", "");
  const port = u.port || (scheme === "https" ? "443" : "80");
  return { target: `${u.hostname}:${port}`, scheme };
}
