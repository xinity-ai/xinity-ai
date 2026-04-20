/**
 * Shared deployment-phase aggregation logic.
 *
 * Both the notification scheduler and the deployment list procedure need to
 * compute the "worst phase" across all installations belonging to a deployment.
 * This module provides the common types and aggregation function.
 */

export type DeploymentPhase = "ready" | "downloading" | "installing" | "failed" | "pending" | "scheduling" | "not_in_catalog";

/** Higher number = worse state. Used to pick the "worst" phase across installations. */
export const PHASE_PRIORITY: Record<string, number> = {
  ready: 1,
  installing: 2,
  downloading: 3,
  scheduling: 3,
  not_in_catalog: 3,
  failed: 4,
};

export type PhaseInfo = {
  phase: DeploymentPhase;
  progress: number | null;
  error: string | null;
  failureLogs: string | null;
};

/**
 * Merges a new installation's phase into the current aggregate for a deployment.
 *
 * Returns the updated aggregate using "worst phase wins" semantics:
 * - If the new phase has higher priority, it replaces the current.
 * - If equal priority and a progress-bearing phase, the higher progress wins.
 * - Returns a new `PhaseInfo` if `current` is undefined (first installation).
 */
export function aggregatePhase(
  current: PhaseInfo | undefined,
  newPhase: DeploymentPhase,
  progress: number | null,
  error: string | null,
  failureLogs: string | null = null,
): PhaseInfo {
  const newPriority = PHASE_PRIORITY[newPhase] ?? 0;

  if (!current) {
    return { phase: newPhase, progress, error, failureLogs };
  }

  const currentPriority = PHASE_PRIORITY[current.phase] ?? 0;

  if (newPriority > currentPriority) {
    return { phase: newPhase, progress, error: error ?? current.error, failureLogs: failureLogs ?? current.failureLogs };
  }

  if (newPriority === currentPriority && (newPhase === "downloading" || newPhase === "installing")) {
    const mergedProgress =
      current.progress == null ? progress
        : progress != null && progress > current.progress ? progress
          : current.progress;
    return { phase: current.phase, progress: mergedProgress, error: error ?? current.error, failureLogs: failureLogs ?? current.failureLogs };
  }

  return current;
}
