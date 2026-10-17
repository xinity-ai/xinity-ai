import { inArray, modelInstallationStateT, modelInstallationT, sql, type ModelInstallation } from "common-db";
import { getDB } from "./db";
import type { DesiredGroup, DesiredState, GroupStage } from "common-env";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "desired-state" });

export type GroupMember = ModelInstallation & { stage: GroupStage | null; stageGeneration: number | null };

export function toDesiredState(nodeId: string, rows: ModelInstallation[], groupMembers: GroupMember[]): DesiredState {
  const groupOf = (row: ModelInstallation): DesiredGroup | null | undefined => {
    if (!row.group) {
      return null;
    }
    const members = groupMembers.filter((member) => member.group?.id === row.group!.id);
    const leader = members.find((member) => member.group!.rank === 0);
    return leader && {
      ...row.group,
      masterAddresses: leader.group!.addresses,
      members: members.map((member) => ({ rank: member.group!.rank, stage: member.stage, generation: member.stageGeneration })).sort((a, b) => a.rank - b.rank),
    };
  };

  return {
    nodeId,
    installations: rows.flatMap((row) => {
      const group = groupOf(row);
      // Without rank 0 a member has nobody to join, and launched alone it would serve as a model of its own.
      if (group === undefined) {
        log.warn({ installationId: row.id, groupId: row.group?.id }, "Group has no rank 0, leaving its member out");
        return [];
      }
      return [{
        installationId: row.id,
        specifier: row.specifier,
        driver: row.driver,
        estCapacity: row.estCapacity,
        kvCacheCapacity: row.kvCacheCapacity,
        hostCapacity: row.hostCapacity,
        maxNumSeqs: row.maxNumSeqs,
        port: row.port,
        settings: row.settings,
        gpuIds: row.gpuIds,
        group,
      }];
    }),
  };
}

async function membersOf(groupIds: string[]): Promise<GroupMember[]> {
  if (groupIds.length === 0) {
    return [];
  }
  const rows = await getDB()
    .select({ installation: modelInstallationT, stage: modelInstallationStateT.groupStage, stageGeneration: modelInstallationStateT.groupGeneration })
    .from(modelInstallationT)
    .leftJoin(modelInstallationStateT, sql`${modelInstallationStateT.id} = ${modelInstallationT.id}`)
    .where(sql`${inArray(sql`${modelInstallationT.group}->>'id'`, groupIds)} AND ${modelInstallationT.deletedAt} IS NULL`);
  return rows.map(({ installation, stage, stageGeneration }) => ({ ...installation, stage, stageGeneration }));
}

export async function buildDesiredState(nodeId: string): Promise<DesiredState> {
  const rows = await getDB()
    .select()
    .from(modelInstallationT)
    .where(sql`${modelInstallationT.nodeId} = ${nodeId} AND ${modelInstallationT.deletedAt} IS NULL`);

  return toDesiredState(nodeId, rows, await membersOf(rows.flatMap((row) => (row.group ? [row.group.id] : []))));
}

export async function nodesOfGroupsOf(installationIds: string[]): Promise<string[]> {
  if (installationIds.length === 0) {
    return [];
  }
  const reported = await getDB()
    .select({ group: modelInstallationT.group })
    .from(modelInstallationT)
    .where(inArray(modelInstallationT.id, installationIds));
  const members = await membersOf(reported.flatMap(({ group }) => (group ? [group.id] : [])));
  return [...new Set(members.map((member) => member.nodeId))];
}
