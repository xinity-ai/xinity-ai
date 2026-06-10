<script lang="ts">
  import type { PageData } from "./$types";
  import UtilizationRing from "./UtilizationRing.svelte";
  import Sparkline from "./Sparkline.svelte";
  import AnimatedNumber from "./AnimatedNumber.svelte";
  import { formatTokens, formatEnergy, formatPercent, formatRelativeTime, gpuSummary } from "$lib/fleet/format";
  import { Zap, ArrowRightLeft, CircleCheck } from "@lucide/svelte";

  type FleetNode = PageData["overview"]["nodes"][number];

  let { node, sparkline, nowMs, rangeLabel }: {
    node: FleetNode;
    sparkline: { t: number; v: number | null }[];
    nowMs: number;
    rangeLabel: string;
  } = $props();

  const successRate = $derived(
    node.usage.requests > 0
      ? ((node.usage.requests - node.usage.failedRequests) / node.usage.requests) * 100
      : null,
  );
  const warmingUp = $derived(node.online && node.metrics === null);

  const lifecycleBadge: Record<string, string> = {
    ready: "bg-gray-100 text-gray-700",
    downloading: "bg-xinity-purple/10 text-xinity-purple animate-pulse",
    installing: "bg-xinity-purple/10 text-xinity-purple animate-pulse",
    failed: "bg-red-50 text-red-600",
  };
</script>

<div class="bg-white rounded-lg shadow p-5 compact:p-3 flex flex-col gap-4 {node.online ? '' : 'opacity-60'}" data-testid="machine-card">
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <span class="relative flex h-2.5 w-2.5 shrink-0" title={node.online ? "Online" : "Offline"}>
          {#if node.online}
            <span class="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60"></span>
            <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          {:else}
            <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-gray-300"></span>
          {/if}
        </span>
        <h3 class="font-semibold text-gray-800 truncate">{node.machineName ?? node.host}</h3>
      </div>
      <p class="text-xs text-gray-400 mt-0.5 truncate" title={gpuSummary(node.gpus)}>
        {node.machineName ? `${node.host} · ` : ""}{gpuSummary(node.gpus) || `${node.gpuCount || "no"} GPU`}
      </p>
    </div>
    {#if !node.online}
      <span class="text-xs text-gray-400 whitespace-nowrap shrink-0">
        {node.lastSeenAt ? `last seen ${formatRelativeTime(node.lastSeenAt, nowMs)}` : "offline"}
      </span>
    {/if}
  </div>

  <div class="flex items-center gap-4">
    {#if warmingUp}
      <div class="flex items-center justify-center" style="width: 88px; height: 88px;">
        <div class="h-16 w-16 rounded-full border-[7px] border-gray-100 animate-pulse"></div>
      </div>
      <div class="flex-1 text-sm text-gray-400 italic">warming up…</div>
    {:else}
      <UtilizationRing value={node.online ? (node.metrics?.gpuUtilizationAvg ?? null) : null} />
      <div class="flex-1 min-w-0">
        <Sparkline points={sparkline} />
        <p class="text-[10px] uppercase tracking-wide text-gray-400 mt-1">load · last {rangeLabel}</p>
      </div>
    {/if}
  </div>

  <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
    <div class="flex items-center gap-1.5 text-gray-600" title="Estimated energy consumed in the selected range">
      <Zap class="w-3.5 h-3.5 text-xinity-coral shrink-0" />
      <span>≈ <AnimatedNumber value={node.energyWh} format={formatEnergy} /></span>
    </div>
    <div class="flex items-center gap-1.5 text-gray-600" title="{node.usage.inputTokens.toLocaleString()} input / {node.usage.outputTokens.toLocaleString()} output tokens">
      <ArrowRightLeft class="w-3.5 h-3.5 text-xinity-purple shrink-0" />
      <span>
        <AnimatedNumber value={node.usage.inputTokens} format={formatTokens} /> in ·
        <AnimatedNumber value={node.usage.outputTokens} format={formatTokens} /> out
      </span>
    </div>
    <div class="flex items-center gap-1.5 text-gray-600 col-span-2" title="Successful requests in the selected range">
      <CircleCheck class="w-3.5 h-3.5 {successRate !== null && successRate < 95 ? 'text-amber-500' : 'text-emerald-500'} shrink-0" />
      {#if successRate === null}
        <span class="text-gray-400">no requests yet</span>
      {:else}
        <span>{formatPercent(successRate)} of <AnimatedNumber value={node.usage.requests} format={formatTokens} /> requests</span>
      {/if}
    </div>
  </div>

  {#if node.models.length > 0}
    <div class="flex flex-wrap gap-1.5 pt-1 border-t border-gray-100">
      {#each node.models as model}
        <span
          class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {lifecycleBadge[model.lifecycleState ?? 'ready'] ?? lifecycleBadge.ready}"
          title="{model.name} ({model.driver}){model.lifecycleState && model.lifecycleState !== 'ready' ? ` · ${model.lifecycleState}` : ''}"
        >
          {model.name.split("/").pop()}
        </span>
      {/each}
    </div>
  {/if}
</div>
