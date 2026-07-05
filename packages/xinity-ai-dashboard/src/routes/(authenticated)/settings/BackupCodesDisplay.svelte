<script lang="ts">
  import { copyToClipboard } from "$lib/copy";
  import { Button } from "$lib/components/ui/button";
  import { Copy } from "@lucide/svelte";

  let { codes, description }: {
    codes: string[];
    description: string;
  } = $props();
</script>

<div class="space-y-2">
  <p class="text-sm text-muted-foreground">{description}</p>
  <div class="grid grid-cols-2 gap-2 p-3 bg-muted rounded-md font-mono text-sm">
    {#each codes as code}
      <span class="select-all">{code}</span>
    {/each}
  </div>
  <Button
    variant="outline"
    size="sm"
    onclick={() => copyToClipboard(codes.join("\n"))}
  >
    <Copy class="w-4 h-4" />
    Copy All
  </Button>
</div>
