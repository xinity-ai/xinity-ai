import type { Component } from "svelte";
import type { ModelWithSpecifier, NodeCapability } from "common-env/model-catalog";
import type { DeploymentOf, DeploymentOutput } from "$lib/orpc/dtos/model.dto";
import type { ModelCompatibility } from "$lib/server/orpc/procedures/cluster.procedure";
import { newModelServes } from "$lib/components/deployments/rollout-advance";
import type { LicensedVram } from "$lib/components/deployments/status-display";
import CanaryModelPanel from "./CanaryModelPanel.svelte";
import LegacyModelPanel from "./LegacyModelPanel.svelte";
import ManagedModelPanel from "./ManagedModelPanel.svelte";
import MigrateNotice from "./MigrateNotice.svelte";
import type { ReplicaGroup } from "./replica-slots";

export type PanelContext = {
  /** What the catalog says per specifier: null when it has no entry, absent while loading. */
  models: Map<string, ModelWithSpecifier | null>;
  canEdit: boolean;
  nodeCapabilities: NodeCapability[];
  modelCompatibility: ModelCompatibility;
  licensedVram: LicensedVram;
  onChanged: () => Promise<void>;
};

type DetailView<D extends DeploymentOutput> = {
  modelPanel: Component<{ deployment: D; context: PanelContext }>;
  notice?: Component<{ deployment: D; context: PanelContext }>;
  /** What replicas without a machine mean for this type, beyond not serving. */
  waitingNote?: (deployment: D, nameOf: (specifier: string) => string) => string | null;
  replicaGroupTitle?: (deployment: D, group: ReplicaGroup, nameOf: (specifier: string) => string) => string;
};

const DETAIL_VIEWS: { [T in DeploymentOutput["type"]]: DetailView<DeploymentOf<T>> } = {
  legacy: {
    modelPanel: LegacyModelPanel,
    notice: MigrateNotice,
  },
  managed: {
    modelPanel: ManagedModelPanel,
  },
  canary: {
    modelPanel: CanaryModelPanel,
    waitingNote: (deployment, nameOf) => {
      if (newModelServes(deployment)) {
        return null;
      }
      const { from, to, progress } = deployment.canary;
      const [next, previous] = from.specifier === to.specifier ? ["the new configuration", "the previous one"] : [nameOf(to.specifier), nameOf(from.specifier)];
      return `Until ${next} serves, its ${progress}% share of traffic goes to ${previous}, and it cannot be promoted.`;
    },
    replicaGroupTitle: ({ canary }, { specifier, side }, nameOf) => {
      const what = canary.from.specifier === canary.to.specifier ? "configuration" : "model";
      return side === "to"
        ? `${nameOf(specifier)}, the new ${what}, ${canary.progress}% of traffic`
        : `${nameOf(specifier)}, the previous ${what}, ${100 - canary.progress}% of traffic`;
    },
  },
};

export function detailViewOf(deployment: DeploymentOutput): DetailView<DeploymentOutput> {
  // TypeScript cannot relate the view for `deployment.type` to `deployment`, though the mapped type guarantees it.
  return DETAIL_VIEWS[deployment.type] as unknown as DetailView<DeploymentOutput>;
}
