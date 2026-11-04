<script lang="ts">
  import { ChevronRight, Copy, Cpu, ExternalLink, Info } from "@lucide/svelte";
  import type { Engine, ModelWithSpecifier } from "common-env/model-catalog";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { copyToClipboard } from "$lib/copy";
  import { formatGb, humanMonthYear } from "$lib/util";
  import LicenseBadge from "./LicenseBadge.svelte";
  import { ENGINE_LABELS, MODEL_TYPE_LABELS } from "./model-labels";

  let {
    specifier,
    preferredDriver,
    model,
    caption,
    compact = false,
    wide = false,
  }: {
    specifier: string;
    preferredDriver?: Engine | null;
    /** What the catalog says about it: undefined while loading, null when it has no entry. */
    model: ModelWithSpecifier | null | undefined;
    caption?: string;
    /** Keeps the description and tags folded away, for a card that shows two models side by side. */
    compact?: boolean;
    /** Puts the description beside the name, for a card as wide as the page. */
    wide?: boolean;
  } = $props();

  const driver = $derived(preferredDriver ?? model?.engine);

  let descriptionEl = $state<HTMLElement | null>(null);
  let expanded = $state(false);
  let overflows = $state(false);
  let detailsOpen = $state(false);

  // Measured rather than guessed from its length, since the card width decides how tall it is.
  $effect(() => {
    const element = descriptionEl;
    if (!element) {
      return;
    }
    const measure = () => {
      overflows = element.scrollHeight > element.clientHeight + 1;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });
</script>

{#snippet description(model: ModelWithSpecifier)}
  <div>
    <!-- A blank line starts a paragraph. A single line break is only how the catalog file wraps its text. -->
    <!-- Folded away behind "About this model" already, so opening that shows all of it. -->
    <p bind:this={descriptionEl} class="text-sm text-muted-foreground whitespace-pre-line {expanded || compact ? '' : wide ? 'line-clamp-6' : 'line-clamp-3'}">{model.description.trim().replace(/([^\n])\n(?!\n)/g, "$1 ")}</p>
    {#if !compact && (overflows || expanded)}
      <button type="button" class="mt-1 text-xs font-medium text-primary hover:underline" onclick={() => (expanded = !expanded)}>
        {expanded ? "Show less" : "Show the full description"}
      </button>
    {/if}
  </div>
{/snippet}

{#snippet facts(model: ModelWithSpecifier)}
  {#if model.tags.length > 0}
    <div class="flex flex-wrap items-center gap-1.5">
      {#each model.tags as tag (tag)}
        <Badge variant="outline" class="font-normal text-muted-foreground">{tag}</Badge>
      {/each}
    </div>
  {/if}
  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
    <span>Weights {formatGb(model.sizing.weightGb)}</span>
    <span title="Released {model.createdAt}">Released {humanMonthYear(model.createdAt)}</span>
    {#if model.url}
      <a href={model.url} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 hover:text-primary">
        Model page <ExternalLink class="w-3 h-3" />
      </a>
    {/if}
  </div>
{/snippet}

<div class="min-w-0 {wide ? 'grid gap-x-8 gap-y-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : 'space-y-3'}">
  <div class="min-w-0 space-y-3">
    <div class="min-w-0 space-y-0.5">
      {#if caption}
        <p class="text-xs text-muted-foreground">{caption}</p>
      {/if}
      <h3 class="{compact ? 'text-base' : 'text-lg'} font-semibold leading-tight wrap-break-word">{model?.name ?? specifier}</h3>
      <div class="flex items-center gap-1 min-w-0">
        <span class="font-mono text-xs text-muted-foreground truncate" title={specifier}>{specifier}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" onclick={() => copyToClipboard(specifier)} title="Copy model specifier" aria-label="Copy model specifier">
          <Copy class="w-3 h-3" />
        </Button>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-1.5 text-sm">
      {#if driver}
        <Badge variant="outline" class="gap-1 font-normal"><Cpu class="w-3 h-3" aria-hidden="true" />{ENGINE_LABELS[driver]}</Badge>
      {/if}
      {#if model}
        <Badge variant="secondary" class="font-normal">{MODEL_TYPE_LABELS[model.type]}</Badge>
        {#if model.isCustom}
          <Badge variant="secondary" class="font-normal">Custom</Badge>
        {/if}
        <LicenseBadge license={model.license} />
      {/if}
    </div>
    {#if wide && model}
      {@render facts(model)}
    {/if}
  </div>

  <div class="min-w-0 space-y-3">
    {#if model === null}
      <p class="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
        <Info class="w-4 h-4 shrink-0 mt-0.5" />
        <span>The current catalog does not describe this model. It keeps running as it is.</span>
      </p>
    {:else if model === undefined}
      <div class="space-y-2 animate-pulse">
        <div class="h-3 bg-muted rounded w-full"></div>
        <div class="h-3 bg-muted rounded w-4/5"></div>
      </div>
    {:else if compact}
      <button type="button" class="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" aria-expanded={detailsOpen} onclick={() => (detailsOpen = !detailsOpen)}>
        <ChevronRight class="h-3.5 w-3.5 transition-transform {detailsOpen ? 'rotate-90' : ''}" aria-hidden="true" />
        About this model
      </button>
      {#if detailsOpen}
        {@render description(model)}
        {@render facts(model)}
      {/if}
    {:else}
      {@render description(model)}
      {#if !wide}
        {@render facts(model)}
      {/if}
    {/if}
  </div>
</div>
