<script lang="ts">
  import { Copy, Info, TriangleAlert } from "@lucide/svelte";
  import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { copyToClipboard } from "$lib/copy";
  import { formatGb } from "$lib/util";
  import { replicaSlots, replicaSlotCounts, type ReplicaSlots } from "./replica-slots";
  import { PHASE_DISPLAY, SLOT_DISPLAY, UNSCHEDULED_DISPLAY } from "$lib/components/deployments/status-display";

  let { deployment, replicas }: { deployment: DeploymentOutput; replicas: number } = $props();

  const REPLICA_DOT_THRESHOLD = 8;
  let expanded = $state(false);

  const slots = $derived(deployment.status ? replicaSlots(replicas, deployment.status.replicas) : undefined);
</script>

{#snippet replicaDots(slots: ReplicaSlots)}
  {#each slots.observed as replica}
    {@const display = PHASE_DISPLAY[replica.phase]}
    <span
      class="w-2.5 h-2.5 rounded-full {display.dot} {display.pulse ? 'animate-pulse' : ''}"
      title="{replica.node ?? 'Unknown node'}: {display.label}{replica.error ? ` (${replica.error})` : ''}"
    ></span>
  {/each}
  {#each { length: slots.missing } as _}
    <span class="w-2.5 h-2.5 rounded-full {UNSCHEDULED_DISPLAY.dot}" title="Not scheduled: no node was free to take this replica"></span>
  {/each}
{/snippet}

{#if deployment.status && slots}
  {@const status = deployment.status}
  {@const failing = status.phase === "failed" || status.phase === "partial"}
  {#if slots.missing > 0}
    <p
      class="text-xs text-amber-600 dark:text-amber-500 cursor-help"
      title="Each replica needs its own node, so a cluster cannot run more replicas than it has nodes. Other causes: no node has enough free VRAM for the model weight, or no available node has the required driver."
    >
      Only {slots.observed.length} of {slots.total} requested replicas are placed.
    </p>
  {/if}
  {#if slots.total > 1}
    {#if slots.total <= REPLICA_DOT_THRESHOLD}
      <div class="flex items-center gap-1 mt-1.5">
        {@render replicaDots(slots)}
      </div>
    {:else}
      {@const counts = replicaSlotCounts(slots)}
      <div class="mt-1.5">
        <div class="flex items-center gap-2">
          <div class="flex h-2 rounded-full overflow-hidden w-24 bg-muted">
            {#each counts as [phase, count]}
              <div class={SLOT_DISPLAY[phase].dot} style="width: {(count / slots.total) * 100}%; min-width: 3px"></div>
            {/each}
          </div>
          <span class="text-xs text-muted-foreground">
            {counts.map(([phase, count]) => `${count} ${SLOT_DISPLAY[phase].label.toLowerCase()}`).join(", ")}
          </span>
        </div>
        <button class="text-xs text-muted-foreground hover:underline cursor-pointer mt-1" onclick={() => (expanded = !expanded)}>
          {expanded ? "Hide replicas" : `Show all ${slots.total} replicas`}
        </button>
        {#if expanded}
          <div class="flex flex-wrap gap-1 mt-1.5">
            {@render replicaDots(slots)}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
  {#each (status.replicas ?? []).filter((replica) => replica.members) as replica, index (index)}
    <dl class="mt-2 space-y-1 text-xs">
      <div class="text-muted-foreground">Across {replica.members!.length} machines</div>
      {#each replica.members! as member (member.node)}
        {@const display = PHASE_DISPLAY[member.phase]}
        <div class="flex justify-between gap-3 pl-3">
          <dt class="flex items-center gap-1.5 min-w-0">
            <span class="w-2 h-2 shrink-0 rounded-full {display.dot} {display.pulse ? 'animate-pulse' : ''}" title={display.label}></span>
            <span class="sr-only">{display.label}:</span>
            <span class="truncate">{member.node}{member.cards > 1 ? `, ${member.cards} cards` : ""}</span>
          </dt>
          <dd class="shrink-0 text-right text-muted-foreground">
            {formatGb(member.gpuGb)} GPU{member.hostGb > 0 ? ` + ${formatGb(member.hostGb)} host` : ""}
          </dd>
        </div>
        {#if member.error}
          <p class="pl-6 text-destructive">{member.error}</p>
        {/if}
      {/each}
      {#if replica.error && !replica.members!.some((member) => member.error)}
        <p class="pl-3 text-destructive">{replica.error}</p>
      {/if}
      {#each replica.couplingIssues ?? [] as issue}
        <p class="flex items-start gap-1 text-amber-700 dark:text-amber-500">
          <TriangleAlert class="w-3 h-3 mt-px shrink-0" aria-hidden="true" />Coupling: {issue.text}
          <a href={issue.docsUrl} target="_blank" rel="noopener noreferrer" title="How to fix this" aria-label="How to fix this" class="text-muted-foreground hover:text-amber-700">
            <Info class="w-3 h-3 mt-px shrink-0" />
          </a>
        </p>
      {/each}
    </dl>
  {/each}
  {#if status.progress != null}
    <div title="{Math.round(status.progress * 100)}%" class="w-full bg-muted rounded-full h-2 mt-2">
      <div class="bg-primary h-2 rounded-full transition-all" style="width: {status.progress * 100}%"></div>
    </div>
  {/if}
  {#if failing && status.error}
    {#if !(status.replicas ?? []).some((replica) => replica.members && replica.error === status.error)}
      <p class="text-sm text-destructive mt-2">{status.error}</p>
    {/if}
    <a href="/docs/deployment-troubleshooting/" class="text-xs text-muted-foreground hover:underline mt-1 inline-block">Troubleshooting guide</a>
  {/if}
  {#if failing && status.failureLogs}
    <Collapsible.Root class="mt-2">
      <div class="flex items-center gap-2">
        <Collapsible.Trigger class="text-xs text-muted-foreground hover:underline cursor-pointer">View logs</Collapsible.Trigger>
        <Button
          variant="ghost"
          size="sm"
          class="h-6 px-2 text-xs text-muted-foreground"
          onclick={() => copyToClipboard(status.failureLogs ?? "")}
          title="Copy all logs"
        >
          <Copy class="w-3.5 h-3.5" />
          Copy logs
        </Button>
      </div>
      <Collapsible.Content>
        <pre class="mt-2 p-3 bg-muted rounded text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap wrap-break-word">{status.failureLogs}</pre>
      </Collapsible.Content>
    </Collapsible.Root>
  {/if}
{/if}
