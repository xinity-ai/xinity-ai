<script lang="ts">
  import * as Tooltip from "$lib/components/ui/tooltip";
  import type { PhaseDisplay } from "./status-display";

  let { display }: { display: PhaseDisplay } = $props();
</script>

<Tooltip.Provider>
  <Tooltip.Root>
    <!-- A span, not a button: in the deployment list the chip sits inside the row's link. -->
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <span {...props} class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide uppercase whitespace-nowrap {display.chip}">
          <span class="w-2 h-2 rounded-full {display.dot} {display.pulse ? 'animate-pulse' : ''}" aria-hidden="true"></span>
          {display.label}
        </span>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content class="max-w-xs">{display.description}</Tooltip.Content>
  </Tooltip.Root>
</Tooltip.Provider>
