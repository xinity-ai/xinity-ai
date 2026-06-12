import type { PageServerLoad } from "./$types";
import { getDB } from "$lib/server/db";
import { aiNodeT, isNull } from "common-db";
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
  const nodes = await db
    .select({ id: aiNodeT.id, host: aiNodeT.host, port: aiNodeT.port, machineName: aiNodeT.machineName })
    .from(aiNodeT)
    .where(isNull(aiNodeT.deletedAt));

  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      target: `${n.host}:${n.port}`,
      machineName: n.machineName,
    })),
    gatewayTarget: hostPort(serverEnv.GATEWAY_URL, 4121),
    dashboardTarget: hostPort(serverEnv.ORIGIN, 5121),
  };
};
