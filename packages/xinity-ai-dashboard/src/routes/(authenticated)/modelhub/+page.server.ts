import type { PageServerLoad } from "./$types";
import { router } from "$lib/server/orpc/router";
import { call } from "@orpc/server";
import { aiNodeT, modelInstallationT, sql } from "common-db";
import { getDB } from "$lib/server/db";
import type { DeploymentWithStatus } from "$lib/server/orpc/procedures/deployment.procedure";

export const load: PageServerLoad = async ({ parent, request }) => {
  const { session } = await parent();
  const activeOrgId = session.activeOrganizationId;

  if (!activeOrgId) {
    return {
      deployments: Promise.resolve([] as DeploymentWithStatus[]),
      maxNodeFreeCapacity: 0,
      availableDrivers: [] as string[],
      nodeFreeCapacities: [] as number[],
    };
  }

  // Stream deployments - page renders immediately with skeletons while this resolves
  const deployments = call(router.deployment.list, { withStatus: true }, { context: { request } });

  // Compute cluster capacity for model selection shading (fast, needed for modal)
  const nodes = await getDB().select().from(aiNodeT).where(sql`${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`);
  const installations = await getDB().select().from(modelInstallationT).where(sql`${modelInstallationT.deletedAt} IS NULL`);

  const nodeUsed = new Map<string, number>();
  for (const inst of installations) {
    nodeUsed.set(inst.nodeId, (nodeUsed.get(inst.nodeId) ?? 0) + inst.estCapacity);
  }

  const maxNodeFreeCapacity = Math.max(
    0,
    ...nodes.map(n => n.estCapacity - (nodeUsed.get(n.id) ?? 0))
  );

  const availableDrivers = [
    ...new Set(
      nodes.filter(n => n.estCapacity - (nodeUsed.get(n.id) ?? 0) > 0)
        .flatMap(n => n.drivers)
    ),
  ];

  const nodeFreeCapacities = nodes
    .map(n => n.estCapacity - (nodeUsed.get(n.id) ?? 0))
    .filter(c => c > 0)
    .sort((a, b) => b - a);

  return {
    deployments,
    maxNodeFreeCapacity,
    availableDrivers,
    nodeFreeCapacities,
  };
};

export type { DeploymentWithStatus as DeploymentDefinition };
