<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Copy } from "@lucide/svelte";
  import { copyToClipboard } from "$lib/copy";

  let { value, copyLabel = "Copy", id }: { value: string; copyLabel?: string; id?: string } = $props();
</script>

<div class="flex items-start gap-2">
  <code {id} class="flex-1 min-w-0 rounded-md bg-muted px-3 py-2 font-mono text-sm break-all select-all">{value}</code>
  <Button variant="outline" size="icon" title={copyLabel} aria-label={copyLabel} onclick={() => copyToClipboard(value)}>
    <Copy class="w-4 h-4" />
  </Button>
</div>
