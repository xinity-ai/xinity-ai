<script lang="ts">
  import { Trophy, Sparkles } from "@lucide/svelte";
  import type { ComplianceFramework } from "./PostureCheckRow.svelte";

  const {
    framework,
    pass,
    total,
  }: { framework: ComplianceFramework; pass: number; total: number } = $props();

  const pct = $derived(total > 0 ? pass / total : 0);
  const percent = $derived(Math.round(pct * 100));
  const complete = $derived(total > 0 && pass === total);

  const RADIUS = 42;
  const CIRC = 2 * Math.PI * RADIUS;
  const offset = $derived(CIRC * (1 - pct));

  const slug = $derived(framework.toLowerCase().replace(/[^a-z0-9]+/g, "-"));

  // Distinct slices of the Xinity brand gradient (violet -> fuchsia -> rose),
  // so the three badges are on-brand yet still tell apart.
  const brand: Record<ComplianceFramework, { grad: [string, string]; glow: string }> = {
    "GDPR": { grad: ["#a78bfa", "#7c3aed"], glow: "#7c3aed" },
    "EU AI Act": { grad: ["#e879f9", "#c026d3"], glow: "#c026d3" },
    "NIS2": { grad: ["#fb7185", "#e11d48"], glow: "#e11d48" },
  };
  const stops = $derived(brand[framework].grad);
  const glow = $derived(brand[framework].glow);
</script>

<div
  class="fw-badge"
  class:complete
  style={`--fw-glow:${glow}`}
  title={`${framework}: ${pass} of ${total} evidence items complete`}
>
  {#if complete}
    <div class="shimmer" aria-hidden="true"></div>
  {/if}
  <div class="ring-wrap">
    <svg viewBox="0 0 100 100" class="ring">
      <defs>
        <linearGradient id={`fwgrad-${slug}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color={stops[0]} />
          <stop offset="100%" stop-color={stops[1]} />
        </linearGradient>
      </defs>
      <circle class="track" cx="50" cy="50" r={RADIUS} />
      <circle
        class="progress"
        cx="50"
        cy="50"
        r={RADIUS}
        stroke={`url(#fwgrad-${slug})`}
        stroke-dasharray={CIRC}
        stroke-dashoffset={offset}
        transform="rotate(-90 50 50)"
      />
    </svg>
    <div class="center">
      {#if complete}
        <Trophy class="trophy" />
      {:else}
        <span class="pct">{percent}<span class="pct-sign">%</span></span>
      {/if}
    </div>
  </div>
  <div class="meta">
    <span class="name">{framework}</span>
    {#if complete}
      <span class="status earned"><Sparkles class="spark" /> Audit-ready</span>
    {:else}
      <span class="status">{pass} / {total} complete</span>
    {/if}
  </div>
</div>

<style>
  .fw-badge {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    width: 9.5rem;
    padding: 1rem 0.75rem 0.85rem;
    border: 1px solid var(--border);
    border-radius: 0.9rem;
    background: var(--card);
    transition: border-color 0.4s ease, box-shadow 0.4s ease;
  }
  .fw-badge.complete {
    border-color: var(--fw-glow);
    animation: breathe 3.2s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { box-shadow: 0 0 0 1px var(--fw-glow), 0 0 13px -5px var(--fw-glow); }
    50% { box-shadow: 0 0 0 1px var(--fw-glow), 0 0 24px -2px var(--fw-glow); }
  }

  /* Diagonal light sweep across earned badges (hue-neutral, works on any brand color). */
  .shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.5) 50%, transparent 70%);
    transform: translateX(-120%);
    animation: sweep 3.6s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes sweep {
    0%, 60% { transform: translateX(-120%); }
    100% { transform: translateX(120%); }
  }

  .ring-wrap { position: relative; width: 5.5rem; height: 5.5rem; }
  .ring { width: 100%; height: 100%; }
  .track {
    fill: none;
    stroke: var(--muted);
    stroke-width: 8;
    opacity: 0.5;
  }
  .progress {
    fill: none;
    stroke-width: 8;
    stroke-linecap: round;
    transition: stroke-dashoffset 1s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .fw-badge.complete .progress {
    filter: drop-shadow(0 0 4px var(--fw-glow));
  }

  .center {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pct { font-size: 1.25rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .pct-sign { font-size: 0.75rem; font-weight: 600; opacity: 0.7; margin-left: 0.05rem; }
  .center :global(.trophy) {
    width: 2rem;
    height: 2rem;
    color: var(--fw-glow);
    filter: drop-shadow(0 0 6px var(--fw-glow));
  }

  .meta { display: flex; flex-direction: column; align-items: center; gap: 0.15rem; }
  .name { font-size: 0.8rem; font-weight: 600; }
  .status { font-size: 0.7rem; color: var(--muted-foreground); }
  .status.earned {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    color: var(--fw-glow);
    font-weight: 600;
  }
  .status.earned :global(.spark) { width: 0.8rem; height: 0.8rem; }

  @media (prefers-reduced-motion: reduce) {
    .fw-badge.complete { animation: none; }
    .shimmer { animation: none; display: none; }
    .progress { transition: none; }
  }
</style>
