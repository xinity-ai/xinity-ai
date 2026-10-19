import { aiNodeT, inArray, type ModelInstallation } from "common-db";
import { rdmaPathsOf, type InstallationGroup, type InterconnectPort } from "common-env";
import { getDB } from "./db";

export type MasterHost = { machineName: string; addresses: InstallationGroup["addresses"] };

type LeaderNode = { machineName: string | null; host: string; interconnect: InterconnectPort[] };

export function masterHostOn(group: InstallationGroup, node: LeaderNode): MasterHost {
  // The machine's own addresses on the group's subnets, where its members can copy rank 0's model files from.
  const subnets = new Set(group.addresses.map(({ subnet }) => subnet));
  const addresses = node.interconnect.flatMap(rdmaPathsOf).filter(({ subnet }) => subnets.has(subnet));
  return { machineName: node.machineName ?? node.host, addresses: addresses.map(({ subnet, address }) => ({ subnet, address })) };
}

export async function masterHostsOf(members: Pick<ModelInstallation, "nodeId" | "group">[]): Promise<Map<string, MasterHost>> {
  const leaders = members.filter((member) => member.group?.rank === 0);
  if (leaders.length === 0) {
    return new Map();
  }
  const nodes = await getDB()
    .select({ id: aiNodeT.id, machineName: aiNodeT.machineName, host: aiNodeT.host, interconnect: aiNodeT.interconnect })
    .from(aiNodeT)
    .where(inArray(aiNodeT.id, leaders.map((leader) => leader.nodeId)));
  return new Map(leaders.flatMap((leader) => {
    const node = nodes.find((candidate) => candidate.id === leader.nodeId);
    return node ? [[leader.group!.id, masterHostOn(leader.group!, node)] as const] : [];
  }));
}
