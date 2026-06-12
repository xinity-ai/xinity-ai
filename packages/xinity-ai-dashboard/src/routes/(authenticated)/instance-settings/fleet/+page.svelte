<script lang="ts">
  import { onMount } from "svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import type { PageData } from "./$types";
  import MachineCard from "./MachineCard.svelte";
  import FleetActivityChart from "./FleetActivityChart.svelte";
  import AnimatedNumber from "./AnimatedNumber.svelte";
  import { formatTokens, formatPercent } from "$lib/fleet/format";
  import { Server, Cpu, ArrowRightLeft, CircleCheck } from "@lucide/svelte";

  let { data }: { data: PageData } = $props();

  const RANGES = [
    { label: "24h", hours: 24 },
    { label: "7d", hours: 7 * 24 },
    { label: "30d", hours: 30 * 24 },
  ];
  const POLL_INTERVAL_MS = 12_000;

  // svelte-ignore state_referenced_locally -- server data only seeds the state; polling owns it afterwards
  let overview = $state(data.overview);
  // svelte-ignore state_referenced_locally -- same as above
  let history = $state(data.history);
  let rangeHours = $state(24);
  async function refresh(hours: number) {
    const [overviewResult, historyResult] = await Promise.all([
      orpc.fleet.overview({ rangeHours: hours }),
      orpc.fleet.history({ rangeHours: hours }),
    ]);
    // Polling is best-effort; on error keep showing the last good data.
    if (!overviewResult[0] && overviewResult[1]) overview = overviewResult[1];
    if (!historyResult[0] && historyResult[1]) history = historyResult[1];
  }

  function setRange(hours: number) {
    rangeHours = hours;
    void refresh(hours);
  }

  onMount(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refresh(rangeHours);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  });

  const rangeLabel = $derived(RANGES.find((r) => r.hours === rangeHours)?.label ?? `${rangeHours}h`);

  const sortedNodes = $derived(
    [...overview.nodes].sort((a, b) =>
      Number(b.online) - Number(a.online) ||
      (a.machineName ?? a.host).localeCompare(b.machineName ?? b.host),
    ),
  );

  const nodeNames = $derived(
    new Map(overview.nodes.map((n) => [n.id, n.machineName ?? n.host])),
  );

  const successRate = $derived(
    overview.totals.requests > 0
      ? ((overview.totals.requests - overview.totals.failedRequests) / overview.totals.requests) * 100
      : null,
  );
</script>

<svelte:head>
  <title>Compute Fleet · Xinity</title>
</svelte:head>

<div class="p-6 compact:p-3">
  <div class="flex flex-wrap items-center justify-between gap-3 mb-6 compact:mb-3">
    <div>
      <h1 class="text-3xl font-bold">Compute</h1>
      <p class="text-sm text-gray-500 mt-1">
        Your machines, live. Statistics are approximate over the selected range.
      </p>
    </div>
    <div class="flex rounded-lg border border-gray-200 bg-white p-0.5 text-sm" role="group" aria-label="Time range">
      {#each RANGES as range}
        <button
          onclick={() => setRange(range.hours)}
          class="px-3 py-1 rounded-md transition-colors cursor-pointer {rangeHours === range.hours
            ? 'bg-xinity-purple/10 text-xinity-purple font-medium'
            : 'text-gray-500 hover:text-gray-800'}"
        >
          {range.label}
        </button>
      {/each}
    </div>
  </div>

  {#if overview.nodes.length === 0}
    <div class="bg-white rounded-lg shadow p-10 text-center">
      <Server class="w-10 h-10 text-gray-300 mx-auto mb-3" />
      <h2 class="text-lg font-medium text-gray-700">No compute connected yet</h2>
      <p class="text-sm text-gray-500 mt-1 max-w-md mx-auto">
        Machines appear here automatically once the Xinity daemon is running on them.
      </p>
    </div>
  {:else}
    <!-- Fleet totals -->
    <!-- TODO(prometheus): restore Gauge + Zap imports and sparklines derived state when Prometheus metrics land -->
    <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4 compact:gap-2 mb-6 compact:mb-3">
      <div class="bg-white rounded-lg shadow p-4 compact:p-3">
        <p class="text-xs text-gray-500 mb-1 flex items-center gap-1"><Server class="w-3.5 h-3.5" /> Machines</p>
        <p class="text-2xl font-bold">
          {overview.totals.machinesOnline}<span class="text-base font-medium text-gray-400">/{overview.totals.machinesTotal}</span>
        </p>
        <p class="text-xs {overview.totals.machinesOnline === overview.totals.machinesTotal ? 'text-emerald-600' : 'text-amber-600'} mt-1">
          {overview.totals.machinesOnline === overview.totals.machinesTotal ? "all online" : "online"}
        </p>
      </div>
      <div class="bg-white rounded-lg shadow p-4 compact:p-3">
        <p class="text-xs text-gray-500 mb-1 flex items-center gap-1"><Cpu class="w-3.5 h-3.5" /> GPUs</p>
        <p class="text-2xl font-bold">{overview.totals.gpuCount}</p>
        <p class="text-xs text-gray-400 mt-1">across the fleet</p>
      </div>
      <!--
      <div class="bg-white rounded-lg shadow p-4 compact:p-3">
        <p class="text-xs text-gray-500 mb-1 flex items-center gap-1"><Gauge class="w-3.5 h-3.5" /> Fleet load</p>
        <p class="text-2xl font-bold">
          {#if overview.totals.utilizationAvg === null}
            <span class="text-gray-300">--</span>
          {:else}
            <AnimatedNumber value={overview.totals.utilizationAvg} format={(v) => `${Math.round(v)}%`} />
          {/if}
        </p>
        <p class="text-xs text-gray-400 mt-1">right now</p>
      </div>
      -->
      <div class="bg-white rounded-lg shadow p-4 compact:p-3">
        <p class="text-xs text-gray-500 mb-1 flex items-center gap-1"><ArrowRightLeft class="w-3.5 h-3.5" /> Tokens</p>
        <p class="text-2xl font-bold">
          <AnimatedNumber value={overview.totals.inputTokens + overview.totals.outputTokens} format={formatTokens} />
        </p>
        <p class="text-xs text-gray-400 mt-1">
          {formatTokens(overview.totals.inputTokens)} in · {formatTokens(overview.totals.outputTokens)} out
        </p>
      </div>
      <!--
      <div class="bg-white rounded-lg shadow p-4 compact:p-3">
        <p class="text-xs text-gray-500 mb-1 flex items-center gap-1"><Zap class="w-3.5 h-3.5" /> Energy</p>
        <p class="text-2xl font-bold">~ <AnimatedNumber value={overview.totals.energyWh} format={formatEnergy} /></p>
        <p class="text-xs text-gray-400 mt-1">last {rangeLabel}</p>
      </div>
      -->
      <div class="bg-white rounded-lg shadow p-4 compact:p-3">
        <p class="text-xs text-gray-500 mb-1 flex items-center gap-1"><CircleCheck class="w-3.5 h-3.5" /> Success</p>
        <p class="text-2xl font-bold">
          {#if successRate === null}
            <span class="text-gray-300">--</span>
          {:else}
            <AnimatedNumber value={successRate} format={formatPercent} />
          {/if}
        </p>
        <p class="text-xs text-gray-400 mt-1">
          {formatTokens(overview.totals.requests)} requests
        </p>
      </div>
    </div>

    <!-- Fleet activity -->
    <div class="bg-white rounded-lg shadow p-5 compact:p-3 mb-6 compact:mb-3">
      <h2 class="text-lg font-medium mb-4 compact:mb-2">Fleet activity <span class="text-sm font-normal text-gray-400">tokens per machine · last {rangeLabel}</span></h2>
      <FleetActivityChart {history} {nodeNames} />
    </div>

    <!-- Machines -->
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 compact:gap-2">
      {#each sortedNodes as node (node.id)}
        <MachineCard {node} {rangeLabel} />
      {/each}
    </div>
  {/if}
</div>
