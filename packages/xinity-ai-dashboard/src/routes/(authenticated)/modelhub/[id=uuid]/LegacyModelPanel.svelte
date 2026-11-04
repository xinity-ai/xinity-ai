<script lang="ts">
  import { Info } from "@lucide/svelte";
  import { humanDate } from "$lib/util";
  import type { DeploymentOf } from "../+page.server";
  import ModelFacts from "../ModelFacts.svelte";
  import TrafficSplit from "$lib/components/deployments/TrafficSplit.svelte";

  let { deployment }: { deployment: DeploymentOf<"legacy"> } = $props();
</script>

<div class="space-y-4">
  {#if deployment.legacy.deprecatedModel}
    <p class="text-sm text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
      <Info class="w-4 h-4 shrink-0 mt-0.5" />
      <span>Uses a model entry in a format that is being retired. It keeps running for now.</span>
    </p>
  {/if}

  {#if deployment.legacy.earlySpecifier}
    <div class="space-y-1">
      <TrafficSplit share={deployment.legacy.progress} from={deployment.legacy.earlySpecifier} to={deployment.legacy.specifier} />
      {#if deployment.legacy.canaryProgressUntil && deployment.legacy.canaryProgressUntil.valueOf() >= Date.now()}
        <p class="text-sm text-muted-foreground">Moves evenly to 100% by {humanDate(deployment.legacy.canaryProgressUntil)}.</p>
      {/if}
    </div>
    <div class="grid gap-6 sm:grid-cols-2">
      <ModelFacts caption="Moving away from" model={{ ...deployment.legacy, specifier: deployment.legacy.earlySpecifier, kvCacheSize: deployment.legacy.earlyKvCacheSize }} />
      <ModelFacts caption="Moving to" model={deployment.legacy} />
    </div>
  {:else}
    <ModelFacts model={deployment.legacy} />
  {/if}
</div>
