<script lang="ts">
  let { share, from, to }: { share: number; from?: string; to?: string } = $props();
</script>

<div>
  <div class="w-full bg-muted rounded-full h-2" title="{share}% of traffic to the new model">
    <div class="bg-primary h-2 rounded-full transition-all" style="width: {share}%"></div>
  </div>
  {#if from && to}
    <div class="flex flex-wrap gap-x-4 mt-1.5 text-xs text-muted-foreground">
      {#if share < 100}
        <span>{100 - share}% to {from}</span>
      {/if}
      <span class="ml-auto">{share}% to {to}</span>
    </div>
  {/if}
</div>
