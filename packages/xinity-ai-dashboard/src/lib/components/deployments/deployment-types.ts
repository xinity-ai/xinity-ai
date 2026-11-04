import type { DeploymentOf, DeploymentOutput } from "$lib/orpc/dtos/model.dto";
import { isSettling } from "./status-display";

export type TypeBadge = { label: string; class: string };

const LEGACY_BADGE: TypeBadge = { label: "Legacy", class: "border-border bg-muted text-muted-foreground" };
const ROLLOUT_BADGE: TypeBadge = { label: "Rolling out", class: "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-400/40 dark:bg-violet-400/10 dark:text-violet-300" };

type DeploymentTypeView<D extends DeploymentOutput> = {
  badge: (deployment: D) => TypeBadge | null;
  models: (deployment: D) => { from?: string; to: string };
  rollingOut: (deployment: D) => boolean;
  advancesOnItsOwn: (deployment: D) => boolean;
  replicas: (deployment: D) => number;
};

const DEPLOYMENT_TYPE_VIEWS: { [T in DeploymentOutput["type"]]: DeploymentTypeView<DeploymentOf<T>> } = {
  legacy: {
    badge: () => LEGACY_BADGE,
    models: ({ legacy }) => ({ from: legacy.earlySpecifier ?? undefined, to: legacy.specifier }),
    rollingOut: ({ legacy }) => Boolean(legacy.earlySpecifier),
    advancesOnItsOwn: () => false,
    replicas: ({ legacy }) => legacy.replicas,
  },
  managed: {
    badge: () => null,
    models: ({ managed }) => ({ to: managed.specifier }),
    rollingOut: () => false,
    advancesOnItsOwn: () => false,
    replicas: ({ managed }) => managed.replicas,
  },
  canary: {
    badge: () => ROLLOUT_BADGE,
    models: ({ canary }) => ({ from: canary.from.specifier, to: canary.to.specifier }),
    rollingOut: () => true,
    advancesOnItsOwn: ({ canary }) => canary.advance.type === "time" && canary.progress < 100,
    replicas: ({ canary }) => canary.replicas,
  },
};

export function viewOf(deployment: DeploymentOutput): DeploymentTypeView<DeploymentOutput> {
  // TypeScript cannot relate the view for `deployment.type` to `deployment`, though the mapped type guarantees it.
  return DEPLOYMENT_TYPE_VIEWS[deployment.type] as unknown as DeploymentTypeView<DeploymentOutput>;
}

const SETTLING_REFRESH_MS = 10_000;
const ROLLOUT_REFRESH_MS = 60_000;
export const IDLE_REFRESH_MS = 120_000;

export function refreshEveryMs(deployment: DeploymentOutput): number | null {
  if (isSettling(deployment)) {
    return SETTLING_REFRESH_MS;
  }
  return viewOf(deployment).advancesOnItsOwn(deployment) ? ROLLOUT_REFRESH_MS : null;
}
