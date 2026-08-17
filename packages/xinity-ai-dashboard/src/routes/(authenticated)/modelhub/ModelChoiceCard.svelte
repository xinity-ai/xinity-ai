<script lang="ts">
  import type { IncompatibilityReason, ModelWithSpecifier } from "xinity-infoserver";
  import { formatGb, humanMonthYear } from "$lib/util";
  import { isRecentlyAdded } from "./model-recency";
  import { Badge } from "$lib/components/ui/badge";
  import LicenseBadge from "./LicenseBadge.svelte";
  import NewModelBadge from "./NewModelBadge.svelte";
  import { ExternalLink, Info, ShieldAlert, HardDrive, CalendarDays, EyeOff, Layers } from "@lucide/svelte";

  let {
    model,
    blockedReason,
    maxNodeFreeCapacity,
    variantCount = 1,
    repeatsPreviousDescription = false,
    onSelect,
  }: {
    model: ModelWithSpecifier;
    blockedReason: IncompatibilityReason | null;
    maxNodeFreeCapacity: number;
    variantCount?: number;
    repeatsPreviousDescription?: boolean;
    onSelect: (model: ModelWithSpecifier) => void;
  } = $props();

  const engineLabel = $derived(model.engine === "vllm" ? "vLLM" : "Ollama");
  const platformLabel = $derived((model.platforms ?? []).join(" or "));

  function undeployableMessage(reason: IncompatibilityReason): string {
    switch (reason) {
      case "missing_driver":
        return `No node runs ${engineLabel}.`;
      case "version_too_old":
      case "version_unknown":
        return `No node has a new enough ${engineLabel} version.`;
      case "missing_feature":
        return `No node's ${engineLabel} build supports the features this model needs.`;
      case "wrong_platform":
        return `No node has a compatible GPU${platformLabel ? ` (needs ${platformLabel})` : ""}.`;
      case "insufficient_capacity":
        return `Needs ${formatGb(model.sizing.weightGb + model.sizing.minKvCacheGb)}, more than the largest node's ${formatGb(maxNodeFreeCapacity)} free.`;
    }
  }
</script>

<div
  role="button"
  tabindex={0}
  class="group relative flex flex-col text-left bg-card border rounded-xl p-4 transition-all duration-200 min-w-0 hover:shadow-lg hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 cursor-pointer"
  onclick={() => onSelect(model)}
  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(model); } }}
>
  <div class="flex justify-between items-start w-full mb-2 gap-2 overflow-hidden">
    <div class="min-w-0 flex-1">
      <h4 class="font-semibold group-hover:text-primary transition-colors truncate" title={model.name}>
        {model.name}
      </h4>
      <p class="text-xs text-muted-foreground font-mono mt-0.5 truncate" title={model.publicSpecifier}>
        {model.publicSpecifier}
      </p>
    </div>
    <div class="flex items-center gap-1.5 shrink-0">
      {#if isRecentlyAdded(model.registeredAt)}
        <NewModelBadge class="text-[10px] uppercase px-1.5 py-0" />
      {/if}
      {#if model.url}
        <a href={model.url} target="_blank" rel="noopener noreferrer"
          class="p-1.5 text-muted-foreground hover:text-primary hover:bg-accent rounded-full transition-colors z-10"
          title="View model info" onclick={(e) => e.stopPropagation()}>
          <ExternalLink class="w-4 h-4" />
        </a>
      {/if}
      {#if model.isCustom}
        <Badge variant="secondary" class="text-[10px] uppercase px-1.5 py-0">Custom</Badge>
      {:else}
        <Badge variant="outline" class="text-[10px] uppercase px-1.5 py-0">{model.type}</Badge>
      {/if}
    </div>
  </div>

  {#if repeatsPreviousDescription}
    <p
      class="text-2xl text-muted-foreground/50 mb-3 grow select-none"
      title="Same description as the previous variant"
      aria-label="Same description as the previous variant"
    >
      〃
    </p>
  {:else}
    <p class="text-sm text-muted-foreground mb-3 line-clamp-2 grow">{model.description}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mb-3">
    <span class="flex items-center gap-1.5">
      <HardDrive class="w-3 h-3 shrink-0" />
      <span>{formatGb(model.sizing.weightGb + model.sizing.minKvCacheGb)}</span>
      <span class="opacity-50">({parseFloat(model.sizing.weightGb.toFixed(2))} model + {parseFloat(model.sizing.minKvCacheGb.toFixed(2))} kv-cache)</span>
    </span>
    <span class="flex items-center gap-1.5" title="Released {model.createdAt}">
      <CalendarDays class="w-3 h-3 shrink-0" />
      <span>{humanMonthYear(model.createdAt)}</span>
    </span>
  </div>

  {#if blockedReason}
    <div class="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400 mb-1">
      <Info class="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{undeployableMessage(blockedReason)} You can still select it and deploy it disabled.</span>
    </div>
  {/if}

  {#if model.unlisted}
    <div class="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground mb-1">
      <EyeOff class="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{model.unlistedReason ?? "Unlisted. Still deployable, but not offered by default."}</span>
    </div>
  {/if}

  {#if model.tags.includes("custom_code")}
    <div class="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400 mb-1">
      <ShieldAlert class="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>Requires custom code execution. Trust must be granted before deploy.</span>
    </div>
  {/if}

  <div class="flex flex-wrap gap-1.5 mt-auto">
    <LicenseBadge license={model.license} class="text-xs" />
    {#each model.tags.slice(0, 4) as tag}
      <Badge variant="secondary" class="text-xs">{tag}</Badge>
    {/each}
    {#if model.tags.length > 4}
      <Badge variant="outline" class="text-xs">+{model.tags.length - 4}</Badge>
    {/if}
  </div>

  {#if variantCount > 1}
    <div class="mt-3 pt-3 border-t flex items-center gap-1.5 text-xs font-medium text-primary">
      <Layers class="w-3.5 h-3.5 shrink-0" />
      Available in {variantCount} variants. Pick one.
    </div>
  {/if}
</div>
