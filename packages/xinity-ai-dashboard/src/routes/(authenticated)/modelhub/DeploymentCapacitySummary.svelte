<script lang="ts">
  import type { NodeCapability } from "common-env/model-catalog";
  import type { PlannedReplica } from "$lib/server/lib/deployments/orchestration";
  import { formatGb } from "$lib/util";
  import { HardDrive, CircleCheck, CircleAlert, Info } from "@lucide/svelte";

  let {
    plannedReplicas = [],
    nodeCapabilities = [],
    enabled = true,
    capacityChecked = false,
    capacityBlocked = false,
    capacityReason,
  }: {
    plannedReplicas?: PlannedReplica[];
    nodeCapabilities?: NodeCapability[];
    enabled?: boolean;
    capacityChecked?: boolean;
    capacityBlocked?: boolean;
    capacityReason?: string;
  } = $props();

  const showsSpecifier = $derived(new Set(plannedReplicas.map((replica) => replica.specifier)).size > 1);
  const totalGpuGb = $derived(plannedReplicas.reduce((sum, replica) => sum + replica.gpuGb, 0));
  const totalHostGb = $derived(plannedReplicas.reduce((sum, replica) => sum + replica.hostGb, 0));
  const totalFree = $derived(nodeCapabilities.reduce((sum, node) => sum + node.free, 0));
</script>

<div class="rounded-lg border bg-muted/30 p-4 space-y-3">
  <div class="flex items-center gap-2 font-medium">
    <HardDrive class="w-4 h-4 text-muted-foreground" />
    Capacity
  </div>

  {#if plannedReplicas.length > 0}
    <dl class="space-y-1.5 text-sm">
      {#each plannedReplicas as replica, index (index)}
        <div class="flex justify-between gap-4">
          <dt class="text-muted-foreground">
            {showsSpecifier ? `${replica.specifier} on ` : ""}{replica.machineName}{replica.cards > 1 ? `, ${replica.cards} cards` : ""}
          </dt>
          <dd class="text-right">
            {formatGb(replica.gpuGb)} GPU{replica.hostGb > 0 ? ` + ${formatGb(replica.hostGb)} host` : ""}
          </dd>
        </div>
      {/each}

      <div class="flex justify-between gap-4 border-t pt-1.5">
        <dt class="text-muted-foreground">Total</dt>
        <dd class="font-semibold text-right">
          {formatGb(totalGpuGb)} GPU{totalHostGb > 0 ? ` + ${formatGb(totalHostGb)} host` : ""}
        </dd>
      </div>

      {#if nodeCapabilities.length > 0}
        <div class="flex justify-between gap-4">
          <dt class="text-muted-foreground">Total cluster free</dt>
          <dd class="text-right">{formatGb(totalFree)}</dd>
        </div>
      {/if}
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
      <span>{capacityReason ?? "This deployment needs more capacity than is currently available"}</span>
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
