<script lang="ts">
  import { browser } from "$app/environment";
  import { Chart, type ChartConfiguration, registerables, registry } from "chart.js";
  import { onMount } from "svelte";

  /**
   * Chart options. Notice: only the data section will induce updates
   */
  export let config: ChartConfiguration;
  export let className: string = "size-full";

  if (browser) registry.add(...registerables);

  let canvas: HTMLCanvasElement;
  let chart: Chart;
  onMount(() => {
    chart = new Chart(canvas, config);
    chart.render();
  });
  $: if (browser && canvas && chart) {
    chart.data.datasets = config.data.datasets;
    Object.assign(chart.options, config.options);
    chart.update();
  }
</script>

<div class={className}>
  <canvas bind:this={canvas}></canvas>
</div>
