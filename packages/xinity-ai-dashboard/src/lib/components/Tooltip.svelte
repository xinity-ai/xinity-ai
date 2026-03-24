<script lang="ts" context="module">
  export type TooltipParams = {
    visible: boolean;
    position: { x: number; y: number };
    text: string;
  };
  export function makeDefaultTooltip(): TooltipParams {
    return { visible: false, position: { x: 0, y: 0 }, text: "" };
  }
</script>

<script lang="ts">
  export let tooltip: TooltipParams;
</script>

{#if tooltip.visible}
  <div class="visible tooltip" style="left: {tooltip.position.x}px; top: {tooltip.position.y}px;">
    {tooltip.text}
  </div>
{/if}

<style>
  /* Tooltip styling */
  .tooltip {
    position: fixed;
    z-index: 1000;
    padding: 5px 10px;
    background-color: #333;
    color: white;
    font-size: 12px;
    border-radius: 4px;
    pointer-events: none;
    transform: translate(-50%, -100%);
    opacity: 0;
    transition: opacity 0.2s;
  }

  .tooltip.visible {
    opacity: 1;
  }
</style>
