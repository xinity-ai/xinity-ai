<script lang="ts">
  import type { Snippet } from "svelte";
  import * as Card from "$lib/components/ui/card";

  let { title, actions, children, class: className = "" }: { title: string; actions?: Snippet; children: Snippet; class?: string } = $props();
</script>

<Card.Root class="gap-3 py-4 compact:gap-2 compact:py-3 {className}">
  <Card.Header class="flex min-h-7 flex-row flex-wrap items-center justify-between gap-2 px-4 compact:px-3">
    <Card.Title role="heading" aria-level={2} class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</Card.Title>
    {#if actions}
      <div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
    {/if}
  </Card.Header>
  <Card.Content class="px-4 compact:px-3">
    {@render children()}
  </Card.Content>
</Card.Root>
