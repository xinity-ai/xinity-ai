<script lang="ts">
  import Chart from "$lib/components/Chart.svelte";
  import type { ComputeHistory } from "$lib/compute/format";
  import { formatTokens } from "$lib/compute/format";

  let { history, nodeNames }: {
    history: ComputeHistory;
    nodeNames: Map<string, string>;
  } = $props();

  const PALETTE = [
    "160, 32, 240", // xinity purple
    "214, 51, 132", // magenta
    "232, 96, 74", // coral
    "124, 58, 237", // violet
    "224, 80, 122", // pink
    "240, 112, 80", // orange
  ];
  const OTHER_COLOR = "156, 163, 175";
  const MAX_STACKED_SERIES = PALETTE.length;
  const ALPHA = 0.75;
  const IN_PROGRESS_ALPHA = 0.3;

  type StackedSeries = { label: string; color: string; tokensByT: Map<number, number> };

  const stackedSeries = $derived.by((): StackedSeries[] => {
    const ranked = history.series
      .map((series) => ({
        label: nodeNames.get(series.nodeId) ?? "removed machine",
        tokensByT: new Map(series.points.map((p) => [p.t, p.tokens])),
        total: series.points.reduce((sum, p) => sum + p.tokens, 0),
      }))
      .sort((a, b) => b.total - a.total);

    if (ranked.length <= MAX_STACKED_SERIES) {
      return ranked.map((series, i) => ({ ...series, color: PALETTE[i] }));
    }

    const top = ranked.slice(0, MAX_STACKED_SERIES - 1);
    const rest = ranked.slice(MAX_STACKED_SERIES - 1);
    const otherByT = new Map<number, number>();
    for (const series of rest) {
      for (const [t, tokens] of series.tokensByT) {
        otherByT.set(t, (otherByT.get(t) ?? 0) + tokens);
      }
    }
    return [
      ...top.map((series, i) => ({ ...series, color: PALETTE[i] })),
      { label: `${rest.length} other machines`, color: OTHER_COLOR, tokensByT: otherByT },
    ];
  });

  function tickLabel(t: number): string {
    const date = new Date(t * 1000);
    if (history.bucketUnit === "day") {
      return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
    }
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function tooltipTitle(index: number): string {
    const start = new Date(history.buckets[index] * 1000);
    const day = start.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const inProgress = index === history.buckets.length - 1 ? " (so far)" : "";
    if (history.bucketUnit === "day") {
      return day + inProgress;
    }
    const end = new Date(start.getTime() + history.bucketSeconds * 1000);
    const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${day}, ${time(start)} to ${time(end)}${inProgress}`;
  }

  const datasets = $derived(
    stackedSeries.map((series) => ({
      label: series.label,
      data: history.buckets.map((t) => series.tokensByT.get(t) ?? 0),
      backgroundColor: history.buckets.map((_, i) =>
        `rgba(${series.color}, ${i === history.buckets.length - 1 ? IN_PROGRESS_ALPHA : ALPHA})`,
      ),
      borderRadius: 2,
      stack: "tokens",
    })),
  );
</script>

<div class="h-64 compact:h-48">
  <Chart
    className="size-full"
    config={{
      type: "bar",
      data: {
        labels: history.buckets.map(tickLabel),
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
              title: (items) => (items.length > 0 ? tooltipTitle(items[0].dataIndex) : ""),
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
