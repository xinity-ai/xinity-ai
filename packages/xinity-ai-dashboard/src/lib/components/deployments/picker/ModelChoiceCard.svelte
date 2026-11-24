<script lang="ts" module>
  import type { IncompatibilityReason } from "common-env/model-catalog";

  export type PickerIncompatibility = Exclude<IncompatibilityReason, "insufficient_capacity">;
</script>

<script lang="ts">
  import type { ModelWithSpecifier } from "common-env/model-catalog";
  import { formatGb, humanMonthYear } from "$lib/util";
  import { ENGINE_LABELS, MODEL_TYPE_LABELS } from "./model-labels";
  import { isRecentlyAdded } from "./model-recency";
  import { Badge } from "$lib/components/ui/badge";
  import LicenseBadge from "./LicenseBadge.svelte";
  import NewModelBadge from "./NewModelBadge.svelte";
  import { Cpu, Info, ShieldAlert, HardDrive, CalendarDays, EyeOff, Layers } from "@lucide/svelte";

  let {
    model,
    blockedReason,
    blockedDetail,
    variantCount = 1,
    repeatsPreviousDescription = false,
    current = false,
    containsCurrent = false,
    title,
    onSelect,
  }: {
    model: ModelWithSpecifier;
    blockedReason: PickerIncompatibility | null;
    blockedDetail?: string;
    variantCount?: number;
    repeatsPreviousDescription?: boolean;
    /** The model the deployment already serves, which it cannot change to. */
    current?: boolean;
    /** A group whose variants include the model the deployment serves. */
    containsCurrent?: boolean;
    title?: string;
    onSelect: (model: ModelWithSpecifier) => void;
  } = $props();

  const engineLabel = $derived(ENGINE_LABELS[model.engine]);
  const platformLabel = $derived((model.platforms ?? []).join(" or "));
  const isVariantGroup = $derived(variantCount > 1);

  function undeployableMessage(reason: PickerIncompatibility): string {
    switch (reason) {
      case "missing_driver":
        return `No node runs ${engineLabel}.`;
      case "version_too_old":
      case "version_unknown":
        return `No node has a new enough ${engineLabel} version.`;
      case "version_blocked":
        return `Every node runs a ${engineLabel} release known not to serve this model.`;
      case "missing_feature":
        return `No node's ${engineLabel} build supports the features this model needs.`;
      case "wrong_platform":
        return `No node has a compatible GPU${platformLabel ? ` (needs ${platformLabel})` : ""}.`;
    }
  }
</script>

<div
  role="button"
  tabindex={current ? -1 : 0}
  aria-disabled={current}
  class="group relative flex flex-col text-left bg-card border rounded-xl p-4 transition-all duration-200 min-w-0 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 {current ? 'border-primary/40 bg-primary/5 cursor-default' : 'hover:shadow-lg hover:border-primary/50 cursor-pointer'}"
  onclick={() => !current && onSelect(model)}
  onkeydown={(e) => { if (!current && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(model); } }}
>
  <div class="flex justify-between items-start w-full mb-2 gap-2 overflow-hidden">
    <div class="min-w-0 flex-1">
      <h4 class="font-semibold group-hover:text-primary transition-colors line-clamp-2 wrap-break-word" title={model.name}>
        {title ?? model.name}
      </h4>
      <p class="text-xs text-muted-foreground font-mono mt-0.5 truncate" title={model.publicSpecifier}>
        {model.publicSpecifier}
      </p>
    </div>
    <div class="flex items-center gap-1.5 shrink-0">
      {#if current}
        <Badge class="text-xs px-1.5 py-0">Current model</Badge>
      {:else if containsCurrent}
        <Badge variant="outline" class="text-xs px-1.5 py-0 border-primary/40 text-primary">Has the current model</Badge>
      {/if}
      {#if isRecentlyAdded(model.registeredAt)}
        <NewModelBadge class="text-[10px] uppercase px-1.5 py-0" />
      {/if}
      {#if model.isCustom}
        <Badge variant="secondary" class="text-[10px] uppercase px-1.5 py-0">Custom</Badge>
      {:else}
        <Badge variant="outline" class="text-xs px-1.5 py-0 font-normal">{MODEL_TYPE_LABELS[model.type]}</Badge>
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
    {#if !isVariantGroup}
      <span class="flex items-center gap-1.5">
        <HardDrive class="w-3 h-3 shrink-0" />
        <span>{formatGb(model.sizing.weightGb)} model size</span>
      </span>
    {/if}
    <span class="flex items-center gap-1.5" title="Released {model.createdAt}">
      <CalendarDays class="w-3 h-3 shrink-0" />
      <span>{humanMonthYear(model.createdAt)}</span>
    </span>
    {#if !isVariantGroup}
      <span class="flex items-center gap-1.5">
        <Cpu class="w-3 h-3 shrink-0" />
        <span>{engineLabel}</span>
      </span>
    {/if}
  </div>

  {#if blockedReason}
    <div class="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400 mb-1">
      <Info class="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>
        {undeployableMessage(blockedReason)}
        {#if !isVariantGroup}You can still select it and deploy it disabled.{/if}
        {#if blockedDetail && !isVariantGroup}
          <span class="block mt-1 opacity-80">{blockedDetail}</span>
        {/if}
      </span>
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
