<script lang="ts">
  import type { NodeCapability } from "common-env/model-catalog";
  import type { CapacityShortfall, PlannedReplicaPreview } from "$lib/server/orpc/procedures/deployment.procedure";
  import type { FootprintPartKind } from "common-env";
  import { formatGb } from "$lib/util";
  import { HardDrive, CircleCheck, CircleAlert, Info, ChevronRight } from "@lucide/svelte";

  let {
    plannedReplicas = [],
    nodeCapabilities = [],
    enabled = true,
    capacityChecked = false,
    capacityBlocked = false,
    capacityReason,
    capacityShortfall,
  }: {
    plannedReplicas?: PlannedReplicaPreview[];
    nodeCapabilities?: NodeCapability[];
    enabled?: boolean;
    capacityChecked?: boolean;
    capacityBlocked?: boolean;
    capacityReason?: string;
    capacityShortfall?: CapacityShortfall;
  } = $props();

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

  const showsSpecifier = $derived(new Set(plannedReplicas.map((replica) => replica.specifier)).size > 1);
  const plannedMachines = $derived(plannedReplicas.flatMap((replica) => replica.machines));
  const sumOf = (machines: typeof plannedMachines, gb: (machine: (typeof plannedMachines)[number]) => number) => machines.reduce((sum, machine) => sum + gb(machine), 0);
  const plannedTotal = $derived([
    [sumOf(plannedMachines.filter((machine) => machine.sharedMemory), (machine) => machine.gpuGb + machine.hostGb), "URAM"],
    [sumOf(plannedMachines.filter((machine) => !machine.sharedMemory), (machine) => machine.gpuGb), "VRAM"],
    [sumOf(plannedMachines.filter((machine) => !machine.sharedMemory), (machine) => machine.hostGb), "RAM"],
  ].flatMap(([gb, memory]) => ((gb as number) > 0 ? [`${formatGb(gb as number)} ${memory}`] : [])).join(" + "));
  const totalFree = $derived(nodeCapabilities.reduce((sum, node) => sum + node.free, 0));
  const closest = $derived(capacityShortfall?.perMachine[0]);
  const closestHostGb = $derived(closest?.parts.filter(({ memory }) => memory === "host").reduce((sum, { gb }) => sum + gb, 0) ?? 0);

  function formatMemory(gpuGb: number, hostGb: number, sharedMemory: boolean): string {
    if (sharedMemory) {
      return `${formatGb(gpuGb + hostGb)} URAM`;
    }
    return [gpuGb > 0 ? `${formatGb(gpuGb)} VRAM` : "", hostGb > 0 ? `${formatGb(hostGb)} RAM` : ""].filter(Boolean).join(" + ");
  }
</script>

{#snippet partRows(parts: CapacityShortfall["perMachine"][number]["parts"], sharedMemory: boolean)}
  <dl class="space-y-1 text-xs">
    {#each parts as { part, memory, gb } (part)}
      <div class="flex justify-between gap-4">
        <dt class="text-muted-foreground">{PART_LABELS[part]}</dt>
        <dd class="text-right">{formatGb(gb)} {sharedMemory ? "URAM" : memory === "gpu" ? "VRAM" : "RAM"}</dd>
      </div>
    {/each}
  </dl>
{/snippet}

<div class="rounded-lg border bg-muted/30 p-4 space-y-3">
  <div class="flex items-center gap-2 font-medium">
    <HardDrive class="w-4 h-4 text-muted-foreground" />
    Capacity
  </div>

  {#if plannedReplicas.length > 0}
    <div class="space-y-1.5 text-sm">
      {#each plannedReplicas as replica, index (index)}
        {#if replica.machines.length > 1}
          <div class="text-muted-foreground">
            {showsSpecifier ? `${replica.specifier} across ` : "Across "}{replica.machines.length} machines
          </div>
        {/if}
        {#each replica.machines as machine (machine.machineName)}
          <details class="group {replica.machines.length > 1 ? `pl-4` : ``}">
            <summary class="flex cursor-pointer list-none justify-between gap-4 [&::-webkit-details-marker]:hidden">
              <span class="inline-flex items-center gap-1 text-muted-foreground">
                <ChevronRight class="w-3 h-3 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                {showsSpecifier && replica.machines.length === 1 ? `${replica.specifier} on ` : ""}{machine.machineName}{machine.cards > 1 ? `, ${machine.cards} cards` : ""}
              </span>
              <span class="text-right">
                {formatMemory(machine.gpuGb, machine.hostGb, machine.sharedMemory)}
              </span>
            </summary>
            <div class="space-y-1 pb-1 pl-4 pt-1">
              {@render partRows(machine.parts, machine.sharedMemory)}
            </div>
          </details>
        {/each}
      {/each}

      <dl>
        <div class="flex justify-between gap-4 border-t pt-1.5">
          <dt class="text-muted-foreground">Total</dt>
          <dd class="font-semibold text-right">
            {plannedTotal}
          </dd>
        </div>

        {#if nodeCapabilities.length > 0}
          <div class="flex justify-between gap-4 pt-1.5">
            <dt class="text-muted-foreground">Total cluster free</dt>
            <dd class="text-right">{formatGb(totalFree)}</dd>
          </div>
        {/if}
      </dl>
    </div>
  {:else if closest && capacityShortfall}
    <dl class="space-y-1.5 text-sm">
      <div class="text-muted-foreground">
        {capacityShortfall.machines > 1 ? `Each of ${capacityShortfall.machines} machines needs` : "Needs on one machine"}
      </div>
      {#each capacityShortfall.perMachine as { machineName, neededGb, freeGb, sharedMemory } (machineName)}
        <div class="flex justify-between gap-4 pl-4">
          <dt class="text-muted-foreground">{machineName}</dt>
          <dd class="text-right">{formatGb(neededGb)} needed, {formatGb(freeGb)} {sharedMemory ? "URAM" : "VRAM"} free</dd>
        </div>
      {/each}
      <div class="text-muted-foreground pt-1.5">What {closest.machineName} needs</div>
      <div class="pl-4">{@render partRows(closest.parts, closest.sharedMemory)}</div>
      <div class="flex justify-between gap-4 border-t pt-1.5">
        <dt class="text-muted-foreground">Total</dt>
        <dd class="font-semibold text-right">
          {closest.sharedMemory ? `${formatGb(closest.neededGb)} URAM` : formatMemory(closest.neededGb, closestHostGb, false)}
        </dd>
      </div>
    </dl>
  {:else if !capacityChecked}
    <p class="text-sm text-muted-foreground">Working out where it would run…</p>
  {/if}

  {#if !enabled}
    <div class="flex items-start gap-2 text-sm text-muted-foreground">
      <Info class="w-4 h-4 shrink-0 mt-0.5" />
      <span>This deployment will be saved disabled. Capacity is only enforced when it is enabled.</span>
    </div>
  {:else if capacityChecked && capacityBlocked}
    <div class="flex items-start gap-2 text-sm text-destructive">
      <CircleAlert class="w-4 h-4 shrink-0 mt-0.5" />
      <span>
        {#if closest}
          Does not fit: {closest.machineName} comes closest and is {formatGb(Math.max(0, closest.neededGb - closest.freeGb))} short.
        {:else}
          {capacityReason ?? "This deployment needs more capacity than is currently available"}
        {/if}
      </span>
    </div>
  {:else if capacityChecked && capacityReason}
    <div class="flex items-start gap-2 text-sm text-muted-foreground">
      <Info class="w-4 h-4 shrink-0 mt-0.5" />
      <span>{capacityReason}</span>
    </div>
  {:else if capacityChecked}
    <div class="flex items-start gap-2 text-sm text-emerald-600 dark:text-emerald-400">
      <CircleCheck class="w-4 h-4 shrink-0 mt-0.5" />
      <span>Fits in the current cluster.</span>
    </div>
  {/if}
</div>
