<script lang="ts">
  import { ArrowRight, CircleCheck } from "@lucide/svelte";
  import type { DeploymentOf } from "$lib/orpc/dtos/model.dto";
  import type { PanelContext } from "./deployment-views";
  import ModelCard from "$lib/components/deployments/picker/ModelCard.svelte";
  import RolloutCard from "./RolloutCard.svelte";
  import type { RolloutAdvance } from "common-env/rollout-advance";
  import { humanDateTime } from "$lib/util";
  import { HOUR_MS, newModelServes } from "$lib/components/deployments/rollout-advance";
  import TrafficSplit from "$lib/components/deployments/TrafficSplit.svelte";

  let { deployment, context }: { deployment: DeploymentOf<"canary">; context: PanelContext } = $props();

  const canary = $derived(deployment.canary);
  const serves = $derived(newModelServes(deployment));
  // Until the new model serves, its share is only the plan: the gateway sends that traffic to the old model.
  const planned = $derived(deployment.enabled && !serves);
  const nameOf = (specifier: string) => context.models.get(specifier)?.name ?? specifier;

  function rateOf(advance: Extract<RolloutAdvance, { type: "time" }>) {
    const perHour = ((100 - advance.startProgress) * HOUR_MS) / Math.max(1, Date.parse(advance.until) - Date.parse(advance.from));
    return perHour >= 1 ? `about ${Math.round(perHour)}% more traffic per hour` : `about ${Math.round(perHour * 24 * 10) / 10}% more traffic per day`;
  }
</script>

<RolloutCard
  {deployment}
  {context}
  promotable={!deployment.enabled || serves}
  promoteBlockedBy="{nameOf(canary.to.specifier)} is not serving yet, so it cannot be promoted."
>
  <div class="space-y-4 compact:space-y-3">
    <div class="space-y-2">
      <div class="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm">
        <span class="min-w-0 wrap-break-word"><span class="font-semibold tabular-nums">{100 - canary.progress}%</span> to {nameOf(canary.from.specifier)}</span>
        <span class="min-w-0 wrap-break-word text-right">
          <span class="font-semibold tabular-nums text-primary">{canary.progress}%</span>
          {planned ? "planned for" : "to"} {nameOf(canary.to.specifier)}
        </span>
      </div>
      <TrafficSplit share={canary.progress} />
      {#if canary.progress === 100}
        <p class="flex items-start gap-2 text-sm">
          <CircleCheck class="w-4 h-4 mt-0.5 shrink-0 text-primary" />
          <span>All traffic is on {nameOf(canary.to.specifier)}. Promote it to finish the rollout and free the old model's memory.</span>
        </p>
      {:else if canary.advance.type === "time"}
        <p class="text-sm text-muted-foreground">
          Started at {canary.advance.startProgress}% on {humanDateTime(canary.advance.from)}. Reaches 100% on <span class="text-foreground">{humanDateTime(canary.advance.until)}</span>, {rateOf(canary.advance)}.
        </p>
      {:else}
        <p class="text-sm text-muted-foreground">Traffic moves only when you set it.</p>
      {/if}
    </div>

    <div class="grid items-start gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
      <div class="rounded-lg border p-3 compact:p-2">
        <ModelCard compact caption="Moving away from" specifier={canary.from.specifier} preferredDriver={canary.from.preferredDriver} model={context.models.get(canary.from.specifier)} />
      </div>
      <ArrowRight class="hidden h-4 w-4 self-center text-muted-foreground md:block" aria-hidden="true" />
      <div class="rounded-lg border p-3 compact:p-2">
        <ModelCard compact caption="Moving to" specifier={canary.to.specifier} preferredDriver={canary.to.preferredDriver} model={context.models.get(canary.to.specifier)} />
      </div>
    </div>

    <p class="text-xs text-muted-foreground">
      The {canary.replicas} replicas are split between the two models by their share of traffic, each running one of them.
    </p>
  </div>
</RolloutCard>
