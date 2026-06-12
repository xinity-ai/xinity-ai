<script lang="ts">
  let { points, max = 100, height = 36 }: {
    /** Time-ordered values; null marks gaps (node offline / no data). */
    points: { t: number; v: number | null }[];
    max?: number;
    height?: number;
  } = $props();

  const WIDTH = 100;

  /** Splits the series into contiguous non-null segments so gaps stay visible. */
  const segments = $derived.by(() => {
    if (points.length < 2) return [] as { x: number; y: number }[][];
    const t0 = points[0]!.t;
    const tSpan = Math.max(1, points[points.length - 1]!.t - t0);
    const result: { x: number; y: number }[][] = [];
    let current: { x: number; y: number }[] = [];
    for (const point of points) {
      if (point.v === null) {
        if (current.length > 1) result.push(current);
        current = [];
        continue;
      }
      current.push({
        x: ((point.t - t0) / tSpan) * WIDTH,
        y: height - 3 - (Math.min(max, point.v) / max) * (height - 6),
      });
    }
    if (current.length > 1) result.push(current);
    return result;
  });

  const linePath = (segment: { x: number; y: number }[]) =>
    segment.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const areaPath = (segment: { x: number; y: number }[]) =>
    `${linePath(segment)} L${segment[segment.length - 1]!.x.toFixed(2)},${height} L${segment[0]!.x.toFixed(2)},${height} Z`;
</script>

<svg viewBox="0 0 {WIDTH} {height}" preserveAspectRatio="none" class="w-full" style="height: {height}px;" aria-hidden="true">
  {#each segments as segment}
    <path d={areaPath(segment)} fill="var(--color-xinity-purple)" opacity="0.08" />
    <path
      d={linePath(segment)}
      fill="none"
      stroke="var(--color-xinity-purple)"
      stroke-width="1.5"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
      opacity="0.75"
    />
  {/each}
</svg>
