<script lang="ts">
  import { Info } from "@lucide/svelte";
  import { humanDate } from "$lib/util";
  import type { DeploymentOf } from "$lib/orpc/dtos/model.dto";
  import type { PanelContext } from "./deployment-views";
  import ModelCard from "$lib/components/deployments/picker/ModelCard.svelte";
  import PanelCard from "$lib/components/deployments/PanelCard.svelte";
  import TrafficSplit from "$lib/components/deployments/TrafficSplit.svelte";

  let { deployment, context }: { deployment: DeploymentOf<"legacy">; context: PanelContext } = $props();
</script>

<PanelCard title={deployment.legacy.earlySpecifier ? "Models" : "Model"}>
  <div class="space-y-5">
    {#if deployment.legacy.deprecatedModel}
      <p class="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
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
      <div class="grid items-start gap-3 md:grid-cols-2">
        <div class="rounded-lg border p-3 compact:p-2">
          <ModelCard
            compact
            caption="Moving away from"
            specifier={deployment.legacy.earlySpecifier}
            preferredDriver={deployment.legacy.preferredDriver}
            model={context.models.get(deployment.legacy.earlySpecifier)}
          />
        </div>
        <div class="rounded-lg border p-3 compact:p-2">
          <ModelCard
            compact
            caption="Moving to"
            specifier={deployment.legacy.specifier}
            preferredDriver={deployment.legacy.preferredDriver}
            model={context.models.get(deployment.legacy.specifier)}
          />
        </div>
      </div>
    {:else}
      <ModelCard
        wide
        specifier={deployment.legacy.specifier}
        preferredDriver={deployment.legacy.preferredDriver}
        model={context.models.get(deployment.legacy.specifier)}
      />
    {/if}
  </div>
</PanelCard>
