<script lang="ts">
  import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
  import { handleVariant, type VariantHandlers } from "$lib/util";
  import { newModelServes } from "$lib/components/deployments/rollout-advance";
  import TrafficSplit from "$lib/components/deployments/TrafficSplit.svelte";

  let { deployment }: { deployment: DeploymentOutput } = $props();

  const SHARES: VariantHandlers<DeploymentOutput, { share: number; planned: boolean } | null> = {
    legacy: ({ legacy }) => (legacy.earlySpecifier ? { share: legacy.progress, planned: false } : null),
    managed: () => null,
    canary: (entry) => ({ share: entry.canary.progress, planned: entry.enabled && !newModelServes(entry) }),
  };

  const rollout = $derived(handleVariant(SHARES, deployment));
</script>

{#if rollout}
  <div class="flex items-center gap-2 text-xs text-muted-foreground">
    <div class="w-24 shrink-0"><TrafficSplit share={rollout.share} /></div>
    <span>{rollout.share}% {rollout.planned ? "planned for" : "to"} the new model</span>
  </div>
{/if}
