<script lang="ts">
  import type { ModelWithSpecifier, NodeCapability } from "xinity-infoserver";
  import { formatGb } from "$lib/util";
  import { HardDrive, CircleCheck, CircleAlert, Info } from "@lucide/svelte";

  let {
    primaryModel,
    canaryModel,
    isCanaryEnabled = false,
    progress = 100,
    replicas = 1,
    kvCacheSize = null,
    earlyKvCacheSize = null,
    effectiveDriver = "vllm",
    maxNodeFreeCapacity = Infinity,
    nodeCapabilities = [],
    enabled = true,
    capacityChecked = false,
    capacityBlocked = false,
    capacityReason,
  }: {
    primaryModel: ModelWithSpecifier | undefined;
    canaryModel?: ModelWithSpecifier | undefined;
    isCanaryEnabled?: boolean;
    progress?: number;
    replicas?: number;
    kvCacheSize?: number | null;
    earlyKvCacheSize?: number | null;
    effectiveDriver?: "ollama" | "vllm";
    maxNodeFreeCapacity?: number;
    nodeCapabilities?: NodeCapability[];
    enabled?: boolean;
    capacityChecked?: boolean;
    capacityBlocked?: boolean;
    capacityReason?: string;
  } = $props();

  // Mirrors the server formula in checkDeploymentCapacity: a model's footprint is
  // its weight plus its effective KV cache (at least the model minimum). Ollama has
  // no KV-cache knob, so the value submitted there is always the minimum.
  function perReplica(model: ModelWithSpecifier, kv: number | null): number {
    const effKv = effectiveDriver === "ollama" ? model.minKvCache : Math.max(kv ?? 0, model.minKvCache);
    return model.weight + effKv;
  }
  function effKvCache(model: ModelWithSpecifier, kv: number | null): number {
    return effectiveDriver === "ollama" ? model.minKvCache : Math.max(kv ?? 0, model.minKvCache);
  }

  const splitsCanary = $derived(Boolean(isCanaryEnabled && canaryModel && progress < 100));

  // Replica counts per model mirror the server split (each rounded up independently).
  const primaryReplicas = $derived(splitsCanary ? Math.ceil(replicas * (progress / 100)) : replicas);
  const canaryReplicas = $derived(splitsCanary ? Math.ceil(replicas * ((100 - progress) / 100)) : 0);

  const primaryPer = $derived(primaryModel ? perReplica(primaryModel, kvCacheSize) : 0);
  const canaryPer = $derived(canaryModel && isCanaryEnabled ? perReplica(canaryModel, earlyKvCacheSize) : 0);

  const totalNeeded = $derived(primaryPer * primaryReplicas + canaryPer * canaryReplicas);

  // With single-node placement, the largest single replica is the binding constraint:
  // it must fit on one machine. Worded to allow a future where a model spans nodes.
  const largestSingle = $derived(Math.max(primaryPer, isCanaryEnabled ? canaryPer : 0));

  const hasAvailability = $derived(Number.isFinite(maxNodeFreeCapacity));
  const totalFree = $derived(nodeCapabilities.reduce((sum, n) => sum + n.free, 0));
</script>

{#if primaryModel}
  <div class="rounded-lg border bg-muted/30 p-4 space-y-3">
    <div class="flex items-center gap-2 font-medium">
      <HardDrive class="w-4 h-4 text-muted-foreground" />
      Capacity
    </div>

    <dl class="space-y-1.5 text-sm">
      <div class="flex justify-between gap-4">
        <dt class="text-muted-foreground">
          {isCanaryEnabled ? "Primary per replica" : "Per replica"}
        </dt>
        <dd class="text-right">
          {formatGb(primaryModel.weight)} model + {formatGb(effKvCache(primaryModel, kvCacheSize))} kv-cache
          = <span class="font-medium">{formatGb(primaryPer)}</span>
          <span class="text-muted-foreground"> &times; {primaryReplicas}</span>
        </dd>
      </div>

      {#if isCanaryEnabled && canaryModel}
        <div class="flex justify-between gap-4">
          <dt class="text-muted-foreground">Canary per replica</dt>
          <dd class="text-right">
            {formatGb(canaryModel.weight)} model + {formatGb(effKvCache(canaryModel, earlyKvCacheSize))} kv-cache
            = <span class="font-medium">{formatGb(canaryPer)}</span>
            <span class="text-muted-foreground"> &times; {canaryReplicas}</span>
          </dd>
        </div>
      {/if}

      <div class="flex justify-between gap-4 border-t pt-1.5">
        <dt class="text-muted-foreground">Total capacity needed</dt>
        <dd class="font-semibold text-right">{formatGb(totalNeeded)}</dd>
      </div>

      <div class="flex justify-between gap-4">
        <dt class="text-muted-foreground">Largest single-machine requirement</dt>
        <dd class="font-medium text-right">{formatGb(largestSingle)}</dd>
      </div>

      {#if hasAvailability}
        <div class="flex justify-between gap-4 border-t pt-1.5">
          <dt class="text-muted-foreground">Largest node free</dt>
          <dd class="text-right">{formatGb(maxNodeFreeCapacity)}</dd>
        </div>
        {#if nodeCapabilities.length > 0}
          <div class="flex justify-between gap-4">
            <dt class="text-muted-foreground">Total cluster free</dt>
            <dd class="text-right">{formatGb(totalFree)}</dd>
          </div>
        {/if}
      {/if}
    </dl>

    <p class="text-xs text-muted-foreground">
      Each replica must currently fit on a single node, so the largest single-machine requirement is the binding limit.
    </p>

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
    {:else if capacityChecked}
      <div class="flex items-start gap-2 text-sm text-emerald-600 dark:text-emerald-400">
        <CircleCheck class="w-4 h-4 shrink-0 mt-0.5" />
        <span>Fits in the current cluster.</span>
      </div>
    {/if}
  </div>
{/if}
