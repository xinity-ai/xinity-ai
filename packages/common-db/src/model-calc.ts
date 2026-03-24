import type { ModelDeployment } from "./schema/models";

export function calcCanaryProgress(deployment: ModelDeployment): number {
  const { progress, earlyModelSpecifier, canaryProgressFrom, canaryProgressUntil } = deployment;
  const notCanary = progress === 100 || !earlyModelSpecifier;
  if (notCanary) {
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