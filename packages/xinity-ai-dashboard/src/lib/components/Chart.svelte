<script lang="ts">
  import { browser } from "$app/environment";
  import { Chart, type ChartConfiguration, registerables, registry } from "chart.js";
  import { onMount } from "svelte";

  let {
    config,
    className = "size-full",
  }: { config: ChartConfiguration; className?: string } = $props();

  if (browser) registry.add(...registerables);

  let canvas: HTMLCanvasElement;
  let chart: Chart | undefined = $state();

  onMount(() => {
    chart = new Chart(canvas, config);
    chart.render();
  });

  $effect(() => {
    if (browser && canvas && chart) {
      chart.data.datasets = config.data.datasets;
      Object.assign(chart.options, config.options);
      chart.update();
    }
  });
</script>

<div class={className}>
  <canvas bind:this={canvas}></canvas>
</div>
