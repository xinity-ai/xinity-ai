<script lang="ts">
  /** A row with an empty label is a note across the whole width. */
  let { rows }: { rows: [label: string, value: string][] } = $props();
</script>

<dl class="grid grid-cols-[fit-content(45%)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
  {#each rows as [label, value], index (index)}
    {#if label}
      <dt class="text-muted-foreground wrap-break-word">{label}</dt>
      <dd class="wrap-break-word">{value}</dd>
    {:else}
      <dd class="col-span-2 text-muted-foreground">{value}</dd>
    {/if}
  {/each}
</dl>
