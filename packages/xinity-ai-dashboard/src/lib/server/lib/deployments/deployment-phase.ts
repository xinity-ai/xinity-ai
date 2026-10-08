/**
 * Shared deployment-phase aggregation logic.
 *
 * Both the notification scheduler and the deployment list procedure need to
 * compute the "worst phase" across all installations belonging to a deployment.
 * This module provides the common types and aggregation function.
 */

import type { lifecycleStateEnum } from "common-db";
type LifecycleState = typeof lifecycleStateEnum.enumValues[number];

export type DeploymentPhase = LifecycleState | "pending" | "scheduling" | "not_in_catalog";
export type DisplayPhase = DeploymentPhase | "partial";

const PHASE_PRIORITY: Record<DeploymentPhase, number> = {
  pending: 0,
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
  hasReady: boolean;
};

export function isProgressBearingPhase(phase: DeploymentPhase): boolean {
  return phase === "downloading" || phase === "installing";
}

export function toDisplayPhase(info: PhaseInfo): DisplayPhase {
  if (info.phase === "failed" && info.hasReady) return "partial";
  return info.phase;
}

function maxNullableProgress(current: number | null, incoming: number | null): number | null {
  if (current == null) return incoming;
  if (incoming == null) return current;
  return Math.max(current, incoming);
}

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
  const isReady = newPhase === "ready";

  if (!current) {
    return { phase: newPhase, progress, error, failureLogs, hasReady: isReady };
  }

  const hasReady = current.hasReady || isReady;
  const newPriority = PHASE_PRIORITY[newPhase];
  const currentPriority = PHASE_PRIORITY[current.phase];

  if (newPriority > currentPriority) {
    return { phase: newPhase, progress, error: error ?? current.error, failureLogs: failureLogs ?? current.failureLogs, hasReady };
  }

  if (newPriority === currentPriority && isProgressBearingPhase(newPhase)) {
    return {
      phase: current.phase,
      progress: maxNullableProgress(current.progress, progress),
      error: error ?? current.error,
      failureLogs: failureLogs ?? current.failureLogs,
      hasReady,
    };
  }

  if (hasReady !== current.hasReady) {
    return { ...current, hasReady };
  }
  return current;
}
