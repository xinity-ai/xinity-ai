<script lang="ts">
  import type { NodeCapability } from "common-env/model-catalog";
  import type { CapacityCheckResult, CapacityShortfall } from "$lib/server/orpc/procedures/deployment.procedure";
  import type { FootprintPartKind } from "common-env";
  import { formatGb, formatMemory } from "$lib/util";
  import { CircleCheck, CircleAlert, Info, ChevronRight, TriangleAlert } from "@lucide/svelte";
  import { shortfallFix, type LicensedVram } from "../status-display";

  let {
    capacity,
    refused = false,
    nodeCapabilities = [],
    licensedVram = null,
    enabled = true,
    asChange = true,
  }: {
    /** Null when the check failed. */
    capacity?: CapacityCheckResult | null;
    /** Whether saving it would be refused, rather than only reported. */
    refused?: boolean;
    nodeCapabilities?: NodeCapability[];
    licensedVram?: LicensedVram;
    enabled?: boolean;
    /** Whether it previews a change to be saved, rather than describing the deployment as it is. */
    asChange?: boolean;
  } = $props();

  const fix = $derived(capacity?.reasonCode ? shortfallFix(capacity.reasonCode) : null);
  const allRunning = $derived((capacity?.replicas ?? []).every((replica) => replica.running));

  const PART_LABELS: Record<FootprintPartKind, string> = {
    weights: "Model weights",
    kvCache: "KV cache",
    engine: "Engine working memory",
    speculative: "Speculative decoding",
    hostWeights: "Weights kept in host memory",
    communicators: "Buffers for the other machines",
    engineProcess: "Engine process",
    imageInput: "Image input",
  };

  const plannedReplicas = $derived(capacity?.replicas ?? []);
  const showsSpecifier = $derived(new Set(plannedReplicas.map((replica) => replica.specifier)).size > 1);
  const plannedMachines = $derived(plannedReplicas.flatMap((replica) => replica.machines));
  const sumOf = (machines: typeof plannedMachines, gb: (machine: (typeof plannedMachines)[number]) => number) => machines.reduce((sum, machine) => sum + gb(machine), 0);
  const plannedTotal = $derived([
    [sumOf(plannedMachines.filter((machine) => machine.sharedMemory), (machine) => machine.gpuGb + machine.hostGb), "unified memory"],
    [sumOf(plannedMachines.filter((machine) => !machine.sharedMemory), (machine) => machine.gpuGb), "VRAM"],
    [sumOf(plannedMachines.filter((machine) => !machine.sharedMemory), (machine) => machine.hostGb), "RAM"],
  ].flatMap(([gb, memory]) => ((gb as number) > 0 ? [`${formatGb(gb as number)} ${memory}`] : [])).join(" + "));
  const totalFree = $derived(nodeCapabilities.reduce((sum, node) => sum + node.free, 0));
  const closest = $derived(capacity?.shortfall?.perMachine[0]);
  const closestHostGb = $derived(closest?.parts.filter(({ memory }) => memory === "host").reduce((sum, { gb }) => sum + gb, 0) ?? 0);
</script>

{#snippet partRows(parts: CapacityShortfall["perMachine"][number]["parts"], sharedMemory: boolean)}
  <dl class="space-y-1 text-xs">
    {#each parts as { part, memory, gb } (part)}
      <div class="flex justify-between gap-4">
        <dt class="text-muted-foreground">{PART_LABELS[part]}</dt>
        <dd class="text-right">{formatGb(gb)} {sharedMemory ? "unified memory" : memory === "gpu" ? "VRAM" : "RAM"}</dd>
      </div>
    {/each}
  </dl>
{/snippet}

<div class="rounded-lg border bg-muted/30 p-4 space-y-3">

  {#if plannedReplicas.length > 0}
    <div class="space-y-1.5 text-sm">
      {#each plannedReplicas as replica, index (index)}
        {#if replica.machines.length > 1}
          <div class="text-muted-foreground">
            {showsSpecifier ? `${replica.specifier} across ` : "Across "}{replica.machines.length} machines
          </div>
        {/if}
        {#each replica.machines as machine, machineIndex (machineIndex)}
          {#if machine.parts.length === 0}
            <div class="flex justify-between gap-4 {replica.machines.length > 1 ? `pl-8` : `pl-4`}">
              <span class="text-muted-foreground">
                {showsSpecifier && replica.machines.length === 1 ? `${replica.specifier} on ` : ""}{machine.machineName}{machine.cards > 1 ? `, ${machine.cards} cards` : ""}{replica.running ? ", already running" : ""}
              </span>
              <span class="text-right">{formatMemory(machine.gpuGb, machine.hostGb, machine.sharedMemory)}</span>
            </div>
          {:else}
            <details class="group {replica.machines.length > 1 ? `pl-4` : ``}">
              <summary class="flex cursor-pointer list-none justify-between gap-4 [&::-webkit-details-marker]:hidden">
                <span class="inline-flex items-center gap-1 text-muted-foreground">
                  <ChevronRight class="w-3 h-3 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                  {showsSpecifier && replica.machines.length === 1 ? `${replica.specifier} on ` : ""}{machine.machineName}{machine.cards > 1 ? `, ${machine.cards} cards` : ""}{replica.running ? ", already running" : ""}
                </span>
                <span class="text-right">
                  {formatMemory(machine.gpuGb, machine.hostGb, machine.sharedMemory)}
                </span>
              </summary>
              <div class="space-y-1 pb-1 pl-4 pt-1">
                {@render partRows(machine.parts, machine.sharedMemory)}
              </div>
            </details>
          {/if}
        {/each}
      {/each}
      {#if capacity && capacity.waiting > 0}
        <div class="flex justify-between gap-4 pl-4 text-amber-700 dark:text-amber-400">
          <span>{capacity.waiting} more {capacity.waiting === 1 ? "replica" : "replicas"}, no machine</span>
          <span class="text-right">{capacity.waiting === 1 ? "waits" : "wait"} {fix?.waitsUntil ?? "for room"}</span>
        </div>
      {/if}

      <dl>
        <div class="flex justify-between gap-4 border-t pt-1.5">
          <dt class="text-muted-foreground">Total</dt>
          <dd class="font-semibold text-right">
            {plannedTotal}
          </dd>
        </div>

        {#if nodeCapabilities.length > 0}
          <div class="flex justify-between gap-4 pt-1.5">
            <dt class="text-muted-foreground">Free on the machines</dt>
            <dd class="text-right">{formatGb(totalFree)}</dd>
          </div>
        {/if}
        {#if licensedVram}
          <div class="flex justify-between gap-4 pt-1.5">
            <dt class="text-muted-foreground">Left under the license</dt>
            <dd class="text-right">{formatGb(Math.max(0, licensedVram.limitGb - licensedVram.usedGb))} of {formatGb(licensedVram.limitGb)} VRAM</dd>
          </div>
        {/if}
      </dl>
    </div>
  {:else if closest && capacity?.shortfall}
    <dl class="space-y-1.5 text-sm">
      <div class="text-muted-foreground">
        {capacity.shortfall.machines > 1 ? `Each of ${capacity.shortfall.machines} machines needs` : "Needs on one machine"}
      </div>
      {#each capacity.shortfall.perMachine as { machineName, neededGb, freeGb, sharedMemory }, machineIndex (machineIndex)}
        <div class="flex justify-between gap-4 pl-4">
          <dt class="text-muted-foreground">{machineName}</dt>
          <dd class="text-right">{formatGb(neededGb)} needed, {formatGb(freeGb)} {sharedMemory ? "unified memory" : "VRAM"} free</dd>
        </div>
      {/each}
      <div class="text-muted-foreground pt-1.5">What {closest.machineName} needs</div>
      <div class="pl-4">{@render partRows(closest.parts, closest.sharedMemory)}</div>
      <div class="flex justify-between gap-4 border-t pt-1.5">
        <dt class="text-muted-foreground">Total</dt>
        <dd class="font-semibold text-right">
          {closest.sharedMemory ? `${formatGb(closest.neededGb)} unified memory` : formatMemory(closest.neededGb, closestHostGb, false)}
        </dd>
      </div>
    </dl>
  {:else if capacity === null}
    <p class="text-sm text-destructive">Could not work out where it would run. Try again in a moment.</p>
  {:else if !capacity}
    <p class="text-sm text-muted-foreground">Working out where it would run…</p>
  {/if}

  {#if asChange && !enabled}
    <div class="flex items-start gap-2 text-sm text-muted-foreground">
      <Info class="w-4 h-4 shrink-0 mt-0.5" />
      <span>This deployment will be saved disabled. Capacity is only enforced when it is enabled.</span>
    </div>
  {:else if refused}
    <div class="flex items-start gap-2 text-sm text-destructive">
      <CircleAlert class="w-4 h-4 shrink-0 mt-0.5" />
      <span>
        {#if closest}
          Does not fit: {closest.machineName} comes closest and is {formatGb(Math.max(0, closest.neededGb - closest.freeGb))} short.
        {:else}
          {capacity?.reason ?? "This deployment needs more capacity than is currently available"}.
          {fix?.text ?? ""}
        {/if}
      </span>
    </div>
  {:else if capacity?.reason}
    <div class="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
      <TriangleAlert class="w-4 h-4 shrink-0 mt-0.5" />
      <span>
        {#if !asChange && !capacity.deployable}
          No replica can be placed now.
        {:else if capacity.waiting > 0}
          {asChange ? "It saves, and " : ""}{capacity.waiting} {capacity.waiting === 1 ? "replica waits" : "replicas wait"} {fix?.waitsUntil ?? "for room"}.
        {/if}
        {capacity.reason}.
        {fix?.text ?? ""}
      </span>
    </div>
  {:else if capacity}
    <div class="flex items-start gap-2 text-sm text-emerald-600 dark:text-emerald-400">
      <CircleCheck class="w-4 h-4 shrink-0 mt-0.5" />
      <span>{allRunning ? "Every replica runs where it is." : "Fits in the current cluster."}</span>
    </div>
  {/if}
</div>
