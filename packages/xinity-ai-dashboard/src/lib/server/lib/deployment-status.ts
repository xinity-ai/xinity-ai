import type { lifecycleStateEnum, ModelDeployment } from "common-db";
import type { DeploymentWithStatus, ReplicaStatus, StatusPhase } from "$lib/orpc/dtos/model.dto";
import { aggregatePhase, isProgressBearingPhase, toDisplayPhase, type PhaseInfo } from "./deployment-phase";

type LifecycleState = typeof lifecycleStateEnum.enumValues[number];

/** One row of the deployment status join, narrowed to the columns the fold reads. */
export type DeploymentStatusRow = {
  model_deployment: ModelDeployment;
  model_installation: { id: string } | null;
  model_installation_state: {
    lifecycleState: LifecycleState;
    progress: number | null;
    errorMessage: string | null;
    failureLogs: string | null;
  } | null;
  ai_node: { machineName: string | null; host: string } | null;
};

/**
 * Folds the status join into one deployment per id, with a replica per installation.
 *
 * A row whose `ai_node` is null sits on a node that was removed or went offline, so it counts as
 * no replica at all: its state row stopped updating when the daemon went away.
 */
export function foldDeploymentStatusRows(rows: DeploymentStatusRow[]): DeploymentWithStatus[] {
  const deploymentMap = new Map<string, { deployment: ModelDeployment; phaseInfo?: PhaseInfo; replicas: ReplicaStatus[] }>();

  for (const row of rows) {
    const deployment = row.model_deployment;
    let entry = deploymentMap.get(deployment.id);
    if (!entry) {
      entry = { deployment, replicas: [] };
      deploymentMap.set(deployment.id, entry);
    }

    const installation = row.model_installation;
    const state = row.model_installation_state;
    const liveNode = row.ai_node;

    if (!installation || !liveNode) continue;

    const nodeLabel = liveNode.machineName ?? liveNode.host;

    if (!state) {
      entry.phaseInfo = aggregatePhase(entry.phaseInfo, "scheduling", null, null);
      entry.replicas.push({ phase: "scheduling", node: nodeLabel, error: null });
      continue;
    }

    const phase = state.lifecycleState;
    const progress = isProgressBearingPhase(phase) ? (state.progress ?? null) : null;
    entry.phaseInfo = aggregatePhase(entry.phaseInfo, phase, progress, state.errorMessage, state.failureLogs);
    entry.replicas.push({ phase, node: nodeLabel, error: state.errorMessage });
  }

  return Array.from(deploymentMap.values()).map(({ deployment, phaseInfo, replicas }) => {
    if (!phaseInfo) return deployment;
    return {
      ...deployment,
      status: {
        phase: toDisplayPhase(phaseInfo) as StatusPhase,
        progress: phaseInfo.progress,
        error: phaseInfo.error,
        failureLogs: phaseInfo.failureLogs,
        replicas: replicas.length > 0 ? replicas : undefined,
      },
    };
  });
}
