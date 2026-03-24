<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { ExternalLink } from "@lucide/svelte";
  import type { ModelWithSpecifier } from "xinity-infoserver";

  let {
    model,
    blockSelectWhenDisabled = true,
    color,
    disabledSpecifier = null,
    onSelect,
    selectedSpecifier
  }: {
    model: ModelWithSpecifier;
    selectedSpecifier: string | null;
    color: "blue" | "purple";
    onSelect?: (specifier: string) => void;
    disabledSpecifier?: string | null;
    blockSelectWhenDisabled?: boolean;
  } = $props();

  const isDisabled = $derived(
    Boolean(disabledSpecifier && model.publicSpecifier === disabledSpecifier),
  );
  const isSelected = $derived(selectedSpecifier === model.publicSpecifier);
  const isInteractive = $derived(Boolean(onSelect) && (!isDisabled || !blockSelectWhenDisabled));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  role={isInteractive ? "button" : undefined}
  tabindex={isInteractive ? 0 : undefined}
  class="w-full text-left border rounded-lg p-4 compact:p-2 transition-all duration-200 bg-card relative group {isInteractive ? 'cursor-pointer' : 'cursor-default'} {isSelected ? 'ring-2' : isInteractive ? 'shadow-sm hover:shadow-md' : 'shadow-sm'} {isSelected && color === 'blue' ? 'ring-primary' : ''} {isSelected && color === 'purple' ? 'ring-purple-500' : ''} {isDisabled ? 'opacity-50 cursor-not-allowed' : ''}"
  onclick={() => isInteractive && onSelect?.(model.publicSpecifier)}
  onkeydown={(e) => {
    if (isInteractive && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onSelect?.(model.publicSpecifier);
    }
  }}
>
  <div class="flex justify-between items-start mb-2 compact:mb-1">
    <div class="pr-8">
      <h4 class="text-base font-semibold">{model.name}</h4>
      <p class="text-xs text-muted-foreground font-mono mt-0.5">
        {model.publicSpecifier}
      </p>
    </div>
    {#if model.isCustom}
      <Badge variant="secondary">Custom</Badge>
    {/if}
  </div>
  <p class="text-sm text-muted-foreground mt-1 compact:mt-0 mb-3 compact:mb-1 min-h-10 compact:min-h-0">
    {model.description}
  </p>
  <div class="flex items-center gap-4 compact:gap-2 text-sm text-muted-foreground">
    <span>Capacity weight: <span class="font-medium">{model.weight}</span></span>
  </div>

  {#if model.url}
    <a
      href={model.url}
      target="_blank"
      rel="noopener noreferrer"
      class="absolute bottom-3 right-3 p-1.5 text-muted-foreground hover:text-primary hover:bg-accent rounded-full transition-colors z-10"
      title="View model info"
      onclick={(e) => e.stopPropagation()}
    >
      <ExternalLink class="w-4 h-4" />
    </a>
  {/if}
</div>
