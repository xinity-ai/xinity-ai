import type { PageServerLoad } from "./$types";
import { getDB } from "$lib/server/db";
import { aiNodeT, isNull, sql } from "common-db";
import { serverEnv } from "$lib/server/serverenv";

function hostPort(rawUrl: string, defaultPort: number): string {
  try {
    const u = new URL(rawUrl);
    const port = u.port || String(defaultPort);
    return `${u.hostname}:${port}`;
  } catch {
    return `localhost:${defaultPort}`;
  }
}

export const load: PageServerLoad = async () => {
  const db = getDB();
  const [{ count: nodeCount }] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(aiNodeT)
    .where(isNull(aiNodeT.deletedAt));

  const dashboardTarget = hostPort(serverEnv.ORIGIN, 5121);

  return {
    nodeCount,
    gatewayTarget: hostPort(serverEnv.GATEWAY_URL, 4121),
    dashboardTarget,
    // Daemon targets are discovered dynamically by Prometheus from this endpoint,
    // so the generated config never needs regenerating as the fleet changes.
    daemonSdUrl: `http://${dashboardTarget}/metrics/sd/daemons`,
  };
};
