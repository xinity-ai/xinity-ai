<script lang="ts">
  import Chart from "$lib/components/Chart.svelte";
  import type { PageData } from "./$types";
  import { formatTokens } from "$lib/fleet/format";

  let { history, nodeNames }: {
    history: NonNullable<PageData["history"]>;
    nodeNames: Map<string, string>;
  } = $props();

  const PALETTE = [
    "rgba(160, 32, 240, 0.75)", // xinity purple
    "rgba(214, 51, 132, 0.75)", // magenta
    "rgba(232, 96, 74, 0.75)", // coral
    "rgba(124, 58, 237, 0.75)", // violet
    "rgba(224, 80, 122, 0.75)", // pink
    "rgba(240, 112, 80, 0.75)", // orange
  ];

  const buckets = $derived.by(() => {
    const all = new Set<number>();
    for (const series of history.series) {
      for (const point of series.points) all.add(point.t);
    }
    return [...all].sort((a, b) => a - b);
  });

  function bucketLabel(t: number): string {
    const date = new Date(t * 1000);
    if (history.bucketSeconds >= 24 * 3600) {
      return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    }
    if (history.bucketSeconds >= 2 * 3600) {
      return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  const datasets = $derived(
    history.series.map((series, i) => {
      const byT = new Map(series.points.map((p) => [p.t, p.tokens]));
      return {
        label: nodeNames.get(series.nodeId) ?? "removed machine",
        data: buckets.map((t) => byT.get(t) ?? 0),
        backgroundColor: PALETTE[i % PALETTE.length],
        borderRadius: 2,
        stack: "tokens",
      };
    }),
  );
</script>

<div class="h-64 compact:h-48">
  <Chart
    className="size-full"
    config={{
      type: "bar",
      data: {
        labels: buckets.map(bucketLabel),
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${formatTokens(ctx.parsed.y ?? 0)} tokens`,
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0 } },
          y: {
            stacked: true,
            beginAtZero: true,
            ticks: { callback: (value) => formatTokens(Number(value)) },
            grid: { color: "rgba(0, 0, 0, 0.04)" },
          },
        },
      },
    }}
  />
</div>
