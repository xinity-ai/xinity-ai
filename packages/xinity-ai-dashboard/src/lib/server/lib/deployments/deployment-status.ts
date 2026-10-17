import type { lifecycleStateEnum, ModelDeployment } from "common-db";
import { couplingDocsUrl, deriveInterconnectOverview, describeCouplingIssue, describePortIssue, type InstallationGroup, type InterconnectPort, type IssueDescription, type PortIssue } from "common-env";
import type { DeploymentWithStatus, ReplicaStatus, StatusPhase } from "$lib/orpc/dtos/model.dto";
import { foldDeployment, foldReplicas, isProgressBearingPhase, toDisplayPhase, type ReplicaMember } from "./deployment-phase";

type LifecycleState = typeof lifecycleStateEnum.enumValues[number];

/** One row of the deployment status join, narrowed to the columns the fold reads. */
export type DeploymentStatusRow = {
  model_deployment: ModelDeployment;
  model_installation: { id: string; group: InstallationGroup | null; gpuIds: string[]; estCapacity: number; hostCapacity: number | null } | null;
  model_installation_state: {
    lifecycleState: LifecycleState;
    progress: number | null;
    errorMessage: string | null;
    failureLogs: string | null;
  } | null;
  ai_node: { id: string; machineName: string | null; host: string; interconnect: InterconnectPort[] } | null;
};

type Member = ReplicaMember & { nodeId: string; node: string; interconnect: InterconnectPort[]; rank: number; cards: number; gpuGb: number; hostGb: number };

/**
 * Folds the status join into one deployment per id, with a replica per installation, or per group
 * for one served across machines.
 *
 * A row whose `ai_node` is null sits on a node that was removed or went offline, so it counts as
 * no replica at all: its state row stopped updating when the daemon went away.
 */
export function foldDeploymentStatusRows(rows: DeploymentStatusRow[]): DeploymentWithStatus[] {
  const deploymentMap = new Map<string, { deployment: ModelDeployment; members: Member[] }>();

  for (const row of rows) {
    const deployment = row.model_deployment;
    let entry = deploymentMap.get(deployment.id);
    if (!entry) {
      entry = { deployment, members: [] };
      deploymentMap.set(deployment.id, entry);
    }

    const installation = row.model_installation;
    const state = row.model_installation_state;
    const liveNode = row.ai_node;

    if (!installation || !liveNode) continue;

    const phase = state?.lifecycleState ?? "scheduling";
    entry.members.push({
      installationId: installation.id,
      group: installation.group,
      rank: installation.group?.rank ?? 0,
      nodeId: liveNode.id,
      node: liveNode.machineName ?? liveNode.host,
      interconnect: liveNode.interconnect,
      cards: Math.max(installation.gpuIds.length, 1),
      gpuGb: installation.estCapacity,
      hostGb: installation.hostCapacity ?? 0,
      phase,
      progress: isProgressBearingPhase(phase) ? (state?.progress ?? null) : null,
      error: state?.errorMessage ?? null,
      failureLogs: state?.failureLogs ?? null,
    });
  }

  return Array.from(deploymentMap.values()).map(({ deployment, members }) => {
    const replicas = foldReplicas(members);
    const phaseInfo = foldDeployment(replicas.map(({ info }) => info));
    if (!phaseInfo) return deployment;
    return {
      ...deployment,
      status: {
        phase: toDisplayPhase(phaseInfo) as StatusPhase,
        progress: phaseInfo.progress,
        error: phaseInfo.error,
        failureLogs: phaseInfo.failureLogs,
        replicas: replicas.length > 0 ? replicas.map(({ info, members }) => replicaStatus(info.phase, info.error, members)) : undefined,
      },
    };
  });
}

function replicaStatus(phase: ReplicaMember["phase"], error: string | null, members: Member[]): ReplicaStatus {
  const byRank = members.toSorted((a, b) => a.rank - b.rank);
  return {
    phase: phase as ReplicaStatus["phase"],
    node: byRank[0]!.node,
    error,
    ...(byRank[0]!.group && {
      members: byRank.map(({ node, phase, error, cards, gpuGb, hostGb }) => ({ node, phase: phase as ReplicaStatus["phase"], error, cards, gpuGb, hostGb })),
      couplingIssues: couplingIssuesOf(byRank),
    }),
  };
}

const NOT_COUPLED: IssueDescription = { text: "its machines are no longer coupled", docsUrl: couplingDocsUrl("no-machine-answers") };

// Neighbour issues are left out: only the group's machines are looked at, so every other machine would look unregistered.
const PATH_ISSUES = new Set<PortIssue["kind"]>(["no-address", "no-rdma-address", "address-keeps-vanishing", "mtu-below-9000"]);

export function couplingIssuesOf(members: Pick<Member, "nodeId" | "node" | "interconnect">[]): IssueDescription[] {
  const overview = deriveInterconnectOverview(members.map(({ nodeId, interconnect }) => ({ id: nodeId, interconnect })));
  const coupling = overview.couplings.find(({ nodeIds }) => members.every(({ nodeId }) => nodeIds.includes(nodeId)));
  if (!coupling) {
    return [NOT_COUPLED];
  }
  const nameOf = (nodeId: string) => members.find((member) => member.nodeId === nodeId)!.node;
  const portIssues = overview.portIssues
    .filter(({ port }) => coupling.members.some((member) => member.nodeId === port.nodeId && member.networkCard === port.networkCard && member.port === port.port))
    .flatMap(({ port, issues }) => issues
      .filter((issue) => PATH_ISSUES.has(issue.kind))
      .map((issue) => {
        const { text, docsUrl } = describePortIssue(issue);
        return { text: `${nameOf(port.nodeId)}: ${text}`, docsUrl };
      }));
  return [...coupling.issues.map(describeCouplingIssue), ...portIssues];
}
