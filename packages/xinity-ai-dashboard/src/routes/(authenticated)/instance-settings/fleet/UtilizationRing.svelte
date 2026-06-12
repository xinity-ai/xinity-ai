<script lang="ts">
  import AnimatedNumber from "./AnimatedNumber.svelte";

  let { value, size = 88 }: {
    /** Utilization 0-100, or null when the node hasn't reported yet. */
    value: number | null;
    size?: number;
  } = $props();

  const gradientId = `ring-${Math.random().toString(36).slice(2)}`;
  const strokeWidth = 7;
  const radius = $derived((size - strokeWidth) / 2);
  const circumference = $derived(2 * Math.PI * radius);
  const offset = $derived(circumference * (1 - Math.min(100, Math.max(0, value ?? 0)) / 100));
</script>

<div class="relative inline-flex items-center justify-center" style="width: {size}px; height: {size}px;">
  <svg width={size} height={size} class="-rotate-90">
    <defs>
      <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="var(--color-xinity-purple)" />
        <stop offset="100%" stop-color="var(--color-xinity-coral)" />
      </linearGradient>
    </defs>
    <circle
      cx={size / 2} cy={size / 2} r={radius}
      fill="none" class="stroke-gray-100" stroke-width={strokeWidth}
    />
    <circle
      cx={size / 2} cy={size / 2} r={radius}
      fill="none" stroke="url(#{gradientId})" stroke-width={strokeWidth} stroke-linecap="round"
      stroke-dasharray={circumference}
      stroke-dashoffset={offset}
      class="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-700"
    />
  </svg>
  <div class="absolute inset-0 flex flex-col items-center justify-center">
    {#if value === null}
      <span class="text-lg font-semibold text-gray-300">—</span>
    {:else}
      <span class="text-lg font-bold text-gray-800"><AnimatedNumber {value} format={(v) => `${Math.round(v)}%`} /></span>
      <span class="text-[10px] uppercase tracking-wide text-gray-400">load</span>
    {/if}
  </div>
</div>
