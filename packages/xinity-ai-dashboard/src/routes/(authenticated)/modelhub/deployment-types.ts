import type { Component, ComponentProps } from "svelte";
import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
import type { DeploymentOf } from "./+page.server";
import CanaryModelPanel from "./[id=uuid]/CanaryModelPanel.svelte";
import DeploymentModal from "./DeploymentModal.svelte";
import LegacyModelPanel from "./[id=uuid]/LegacyModelPanel.svelte";
import ManagedModelPanel from "./[id=uuid]/ManagedModelPanel.svelte";

type DeploymentTypeView<D extends DeploymentOutput> = {
  /** Marks the deployment in the overview, or null for the ordinary case. */
  badge: (deployment: D) => string | null;
  /** The model it serves, and during a rollout the one it moves away from. */
  models: (deployment: D) => { from?: string; to: string };
  /** Share of traffic, in percent, going to `to` during a rollout. */
  traffic: (deployment: D) => number | null;
  replicas: (deployment: D) => number;
  panel: Component<{ deployment: D }>;
  editModal?: Component<Omit<ComponentProps<typeof DeploymentModal>, "deployment"> & { deployment: D }>;
};

const DEPLOYMENT_TYPE_VIEWS: { [T in DeploymentOutput["type"]]: DeploymentTypeView<DeploymentOf<T>> } = {
  legacy: {
    badge: () => "Legacy",
    models: ({ legacy }) => ({ from: legacy.earlySpecifier ?? undefined, to: legacy.specifier }),
    traffic: ({ legacy }) => (legacy.earlySpecifier ? legacy.progress : null),
    replicas: ({ legacy }) => legacy.replicas,
    panel: LegacyModelPanel,
    editModal: DeploymentModal,
  },
  managed: {
    badge: () => null,
    models: ({ managed }) => ({ to: managed.specifier }),
    traffic: () => null,
    replicas: ({ managed }) => managed.replicas,
    panel: ManagedModelPanel,
  },
  canary: {
    badge: () => "Rolling out",
    models: ({ canary }) => ({ from: canary.from.specifier, to: canary.to.specifier }),
    traffic: ({ canary }) => canary.progress,
    replicas: ({ canary }) => canary.replicas,
    panel: CanaryModelPanel,
  },
};

export function viewOf(deployment: DeploymentOutput): DeploymentTypeView<DeploymentOutput> {
  // TypeScript cannot relate the view for `deployment.type` to `deployment`, though the mapped type guarantees it.
  return DEPLOYMENT_TYPE_VIEWS[deployment.type] as unknown as DeploymentTypeView<DeploymentOutput>;
}
