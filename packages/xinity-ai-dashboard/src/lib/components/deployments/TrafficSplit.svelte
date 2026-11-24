<script lang="ts">
  let { share, from, to }: { share: number; from?: string; to?: string } = $props();
</script>

<div class="min-w-0">
  <div class="flex w-full h-2 gap-0.5" role="img" aria-label="{share}% of traffic to the new model" title="{share}% of traffic to the new model">
    {#if share < 100}
      <div class="h-2 rounded-full bg-muted-foreground/25" style="width: {100 - share}%"></div>
    {/if}
    {#if share > 0}
      <div class="h-2 rounded-full bg-primary transition-all" style="width: {share}%"></div>
    {/if}
  </div>
  {#if from && to}
    <div class="flex justify-between gap-4 mt-1.5 text-xs text-muted-foreground">
      <span class="min-w-0 truncate" title="{100 - share}% to {from}">{share < 100 ? `${100 - share}% to ${from}` : ""}</span>
      <span class="min-w-0 truncate text-right font-medium text-foreground" title="{share}% to {to}">{share}% to {to}</span>
    </div>
  {/if}
</div>
