<script lang="ts">
  import { Info } from "@lucide/svelte";
  import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
  import { statusDisplayOf, UNPLACED_EXPLANATION } from "./status-display";

  let { deployment }: { deployment: DeploymentOutput } = $props();

  const display = $derived(statusDisplayOf(deployment));
</script>

<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide uppercase whitespace-nowrap {display.chip}">
  <span class="w-2 h-2 rounded-full {display.dot} {display.pulse ? 'animate-pulse' : ''}"></span>
  {display.label}
  {#if deployment.enabled && !deployment.status}
    <span class="ml-0.5 cursor-help" title={UNPLACED_EXPLANATION}><Info class="w-3 h-3" /></span>
  {/if}
</span>
