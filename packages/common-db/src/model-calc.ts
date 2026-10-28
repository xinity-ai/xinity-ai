import type { DeploymentLegacy } from "./schema/models";

/** Share of traffic, in percent, that has moved to the rollout's new side by now. */
export function calcRolloutProgress(rollout: Pick<DeploymentLegacy, "progress" | "canaryProgressFrom" | "canaryProgressUntil">): number {
  const { progress, canaryProgressFrom, canaryProgressUntil } = rollout;
  if (progress === 100) {
    return 100;
  }
  if (canaryProgressUntil && canaryProgressUntil.valueOf() < Date.now()) {
    return 100;
  }
  if (!canaryProgressFrom || !canaryProgressUntil) {
    return progress;
  }
  const start = canaryProgressFrom.valueOf();
  const end = canaryProgressUntil.valueOf();
  const totalDuration = end - start;
  if (totalDuration <= 0) {
    return progress;
  }
  const elapsed = Math.max(0, Math.min(Date.now() - start, totalDuration));
  const interpolated = progress + ((100 - progress) * (elapsed / totalDuration));
  return Math.max(0, Math.min(interpolated, 99));
}

export function calcCanaryProgress(deployment: Pick<DeploymentLegacy, "progress" | "earlySpecifier" | "canaryProgressFrom" | "canaryProgressUntil">): number {
  return deployment.earlySpecifier ? calcRolloutProgress(deployment) : 100;
}
