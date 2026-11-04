<script lang="ts">
  import type { RolloutAdvance } from "common-env/rollout-advance";
  import { handleVariant, humanDate, type VariantHandlers } from "$lib/util";
  import type { DeploymentOf } from "../+page.server";
  import ModelFacts from "../ModelFacts.svelte";
  import TrafficSplit from "$lib/components/deployments/TrafficSplit.svelte";

  let { deployment }: { deployment: DeploymentOf<"canary"> } = $props();

  const ADVANCE_DESCRIPTIONS: VariantHandlers<RolloutAdvance, string> = {
    manual: () => "Progress is set by hand.",
    time: ({ until }) => `Moves evenly to 100% by ${humanDate(new Date(until))}.`,
  };

  const advanceDescription = $derived(handleVariant(ADVANCE_DESCRIPTIONS, deployment.canary.advance));
</script>

<div class="space-y-4">
  <div class="space-y-1">
    <TrafficSplit share={deployment.canary.progress} from={deployment.canary.from.specifier} to={deployment.canary.to.specifier} />
    <p class="text-sm text-muted-foreground">
      {deployment.canary.progress === 100 ? "All traffic has moved to the new model." : advanceDescription}
      The {deployment.canary.replicas} {deployment.canary.replicas === 1 ? "replica is" : "replicas are"} shared between both models by traffic.
    </p>
  </div>
  <div class="grid gap-6 sm:grid-cols-2">
    <ModelFacts caption="Moving away from" model={deployment.canary.from} />
    <ModelFacts caption="Moving to" model={deployment.canary.to} />
  </div>
</div>
