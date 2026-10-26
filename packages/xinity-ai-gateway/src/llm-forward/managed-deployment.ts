import { sql, inArray, deploymentManagedT, type Deployment } from "common-db";
import { getDB } from "../db";
import type { GatewayDeploymentType, ModelDescription } from "./deployment-types";
import type { ModelLookup } from "./model-data";
import { deriveStatus, getModelSources, placedInstallations, replicaLifecycles, resolveMaxContextLengths, selectAdmittedHost, shortestContext, type LifecycleState } from "./installations";

export type ManagedPayload = { id: string; specifier: string };

export async function loadManagedRow(id: string): Promise<ManagedPayload | undefined> {
  const [row] = await getDB().select({ id: deploymentManagedT.id, specifier: deploymentManagedT.specifier })
    .from(deploymentManagedT)
    .where(sql`${deploymentManagedT.id} = ${id}`)
    .limit(1);
  return row;
}

export async function resolveManaged(payload: ManagedPayload, publicSpecifier: string, prefixHashes?: string[]): Promise<ModelLookup> {
  const sources = await getModelSources({ column: "managedId", id: payload.id }, payload.specifier);
  return selectAdmittedHost({ final: { specifier: payload.specifier, sources }, progress: 100, publicSpecifier, prefixHashes });
}

export type ManagedState = { specifier: string; status: LifecycleState | null; maxModelLen: number };

/** Status and context length of each managed row, keyed by its id. Rows that do not exist are left out. */
export async function describeManagedRows(ids: string[]): Promise<Map<string, ManagedState>> {
  if (ids.length === 0) {
    return new Map();
  }
  const [rows, placed] = await Promise.all([
    getDB().select({ id: deploymentManagedT.id, specifier: deploymentManagedT.specifier })
      .from(deploymentManagedT)
      .where(inArray(deploymentManagedT.id, ids)),
    placedInstallations("managedId", ids),
  ]);
  const contextLengths = await resolveMaxContextLengths([...new Set(rows.map(({ specifier }) => specifier))]);
  return new Map(rows.map(({ id, specifier }) => [id, {
    specifier,
    status: deriveStatus(replicaLifecycles(placed.get(id) ?? [])),
    maxModelLen: shortestContext([specifier], contextLengths),
  }]));
}

async function describeManaged(entries: Deployment[]): Promise<Map<string, ModelDescription>> {
  const states = await describeManagedRows(entries.flatMap((entry) => entry.managedId ?? []));
  return new Map(entries.flatMap((entry) => {
    const state = entry.managedId ? states.get(entry.managedId) : undefined;
    return state ? [[entry.id, { status: state.status, canary: false, maxModelLen: state.maxModelLen }] as const] : [];
  }));
}

export const managedDeployment: GatewayDeploymentType<ManagedPayload> = {
  load: (entry) => (entry.managedId ? loadManagedRow(entry.managedId) : Promise.resolve(undefined)),
  resolve: resolveManaged,
  describe: describeManaged,
};
