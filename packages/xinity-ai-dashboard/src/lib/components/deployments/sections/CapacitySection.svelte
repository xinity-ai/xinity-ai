<script lang="ts">
  import { ChevronRight } from "@lucide/svelte";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import type { ModelWithSpecifier } from "common-env/model-catalog";
  import { capacityPreview, capacityRequestOf } from "./capacity-preview.svelte";
  import DeploymentCapacitySummary from "./DeploymentCapacitySummary.svelte";
  import { kvCacheSettable, partsOf, type SectionProps } from "./deployment-sections";
  import SummaryList from "./SummaryList.svelte";
  import { formatGb } from "$lib/util";

  let { draft = $bindable(), context, editing, changed, blocked = $bindable() }: SectionProps = $props();

  const kvCacheLocked = $derived(context.enabled && !context.creating);
  const clusterFreeGb = $derived(context.nodeCapabilities.reduce((sum, node) => sum + node.free, 0));
  // During a rollout each model has machines of its own, so no single count describes both.
  const machinesThatRun = $derived.by(() => {
    const { members } = partsOf(draft);
    return members.length === 1 ? context.modelCompatibility[members[0]!.member.specifier]?.machines : undefined;
  });

  const replicasError = $derived.by(() => {
    const { budget, minReplicas } = partsOf(draft);
    return Number.isInteger(budget.replicas) && budget.replicas >= minReplicas
      ? null
      : `Run at least ${minReplicas} ${minReplicas === 1 ? "replica" : "replicas"}, as a whole number.`;
  });

  let showBreakdown = $state(false);
  // What is already deployed and unchanged is reported, not refused.
  const preview = capacityPreview(
    () => ((editing && !replicasError) || (!editing && showBreakdown) ? capacityRequestOf(draft, context.creating ? undefined : draft.id) : null),
    () => context.enabled && changed,
  );

  $effect(() => {
    blocked = Boolean(replicasError) || preview.refused;
  });

  // During a rollout each model has a cache of its own, so the label names the model.
  const kvCacheLabel = (label: string | null, specifier: string) => (label ? `KV cache of ${context.models.get(specifier)?.name ?? specifier}` : "KV cache");

  function kvCacheText(model: ModelWithSpecifier | null | undefined, kvCacheSize: number | null | undefined): string {
    if (model === undefined) {
      return "…";
    }
    if (model && !kvCacheSettable(model)) {
      return "Sized by the engine";
    }
    if (kvCacheSize) {
      return `${kvCacheSize} GB`;
    }
    return model ? `${model.sizing.minKvCacheGb} GB, the model's minimum` : "Model default";
  }
</script>

{#if !editing}
  {@const { budget, members } = partsOf(draft)}
  <SummaryList
    rows={[
      ["Replicas", String(budget.replicas)],
      ...members.map(({ label, member }): [string, string] => [kvCacheLabel(label, member.specifier), kvCacheText(context.models.get(member.specifier), member.kvCacheSize)]),
    ]}
  />
  <button type="button" class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" aria-expanded={showBreakdown} onclick={() => (showBreakdown = !showBreakdown)}>
    <ChevronRight class="h-3.5 w-3.5 transition-transform {showBreakdown ? 'rotate-90' : ''}" aria-hidden="true" />
    Placement and memory
  </button>
  {#if showBreakdown}
    <div class="mt-3">
      <DeploymentCapacitySummary capacity={preview.result} nodeCapabilities={context.nodeCapabilities} licensedVram={context.licensedVram} asChange={false} />
    </div>
  {/if}
{:else}
  <div class="space-y-5">
    <div class="space-y-1.5">
      <Label for="replicas">Replicas</Label>
      <Input id="replicas" type="number" min={partsOf(draft).minReplicas} step="1" bind:value={() => partsOf(draft).budget.replicas, (replicas) => (partsOf(draft).budget.replicas = replicas)} class="max-w-32" aria-invalid={Boolean(replicasError)} aria-describedby="replicas-hint" />
      {#if replicasError}
        <p class="text-xs text-destructive">{replicasError}</p>
      {/if}
      <p id="replicas-hint" class="text-xs text-muted-foreground">
        {#if machinesThatRun !== undefined}
          {machinesThatRun} {machinesThatRun === 1 ? "machine has" : "machines have"} the engine this model needs.
        {/if}
        A machine runs one replica at most.
        {#if partsOf(draft).members.length > 1}
          The two models split the replicas by traffic, so a rollout needs at least {partsOf(draft).minReplicas}.
        {/if}
      </p>
    </div>

    {#each partsOf(draft).members as { label, member }, index (index)}
      {@const model = context.models.get(member.specifier)}
      {#if model && kvCacheSettable(model) && kvCacheLocked}
        <div class="space-y-0.5">
          <p class="text-sm wrap-break-word">{kvCacheLabel(label, member.specifier)}: {kvCacheText(model, member.kvCacheSize)}</p>
          <p class="text-xs text-muted-foreground">Disable the deployment to change the KV cache size.</p>
        </div>
      {:else if model && kvCacheSettable(model)}
        {@const min = model.sizing.minKvCacheGb}
        {@const max = Math.max(min, Math.floor((clusterFreeGb - model.sizing.weightGb) * 10) / 10)}
        <div class="space-y-1.5">
          <Label for="kv-cache-{index}" class="block wrap-break-word">
            {kvCacheLabel(label, member.specifier)}: <span class="font-bold text-primary">{member.kvCacheSize ?? min} GB</span>
          </Label>
          <input
            id="kv-cache-{index}"
            type="range" {min} max={max > min ? max : min + 1} step="0.1"
            value={member.kvCacheSize ?? min}
            oninput={(event) => (member.kvCacheSize = event.currentTarget.valueAsNumber)}
            class="w-full accent-primary cursor-pointer"
          />
          <p class="text-xs text-muted-foreground">
            Min: {min} GB · Max: {max} GB, what the machines have free. Larger values serve more requests at once.
            {#if context.licensedVram}
              Your license leaves {formatGb(Math.max(0, context.licensedVram.limitGb - context.licensedVram.usedGb))} of VRAM for new replicas.
            {/if}
          </p>
        </div>
      {:else if model}
        <p class="text-sm text-muted-foreground wrap-break-word">{kvCacheLabel(label, member.specifier)}: sized by the engine itself.</p>
      {:else if model === null}
        <p class="text-sm text-muted-foreground wrap-break-word">{kvCacheLabel(label, member.specifier)}: the catalog does not describe this model, so it cannot be sized here.</p>
      {/if}
    {/each}

    {#if !replicasError}
      <DeploymentCapacitySummary capacity={preview.result} refused={preview.refused} nodeCapabilities={context.nodeCapabilities} licensedVram={context.licensedVram} enabled={context.enabled} />
    {/if}
  </div>
{/if}
