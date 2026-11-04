<script lang="ts">
  import { Copy, Info, TriangleAlert } from "@lucide/svelte";
  import type { DeploymentOutput, ReplicaStatus } from "$lib/orpc/dtos/model.dto";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { copyToClipboard } from "$lib/copy";
  import { formatMemory } from "$lib/util";
  import { modelSlots, replicaSlotCounts, type ReplicaGroup } from "./replica-slots";
  import { SLOT_DISPLAY, UNSCHEDULED_DISPLAY } from "$lib/components/deployments/status-display";

  let {
    deployment,
    titleOf,
  }: {
    deployment: DeploymentOutput;
    titleOf: (group: ReplicaGroup) => string;
  } = $props();

  const models = $derived(deployment.status ? modelSlots(deployment.status.wanted, deployment.status.replicas ?? []) : []);
</script>

{#snippet unplacedRow()}
  <li class="flex items-center justify-between gap-3 px-3 py-2 compact:py-1">
    <span class="flex items-center gap-2">
      <span class="w-2.5 h-2.5 shrink-0 rounded-full {UNSCHEDULED_DISPLAY.dot}"></span>
      <span class="text-muted-foreground">No machine yet</span>
    </span>
    <span class="shrink-0 text-xs text-muted-foreground">{UNSCHEDULED_DISPLAY.label}</span>
  </li>
{/snippet}

{#snippet replicaRow(replica: ReplicaStatus)}
  {@const display = SLOT_DISPLAY[replica.phase]}
  <li class="px-3 py-2 compact:py-1 space-y-1">
    <div class="flex items-center justify-between gap-3">
      <span class="flex items-center gap-2 min-w-0">
        <span class="w-2.5 h-2.5 shrink-0 rounded-full {display.dot} {display.pulse ? 'animate-pulse' : ''}"></span>
        <span class="wrap-break-word">{replica.members ? `Across ${replica.members.length} machines` : replica.node ?? "Unknown machine"}</span>
      </span>
      {#if replica.phase !== "ready"}
        <span class="shrink-0 text-xs text-muted-foreground">{display.label}</span>
      {/if}
    </div>
    {#each replica.members ?? [] as member, rank (rank)}
      {@const memberDisplay = SLOT_DISPLAY[member.phase]}
      <div class="flex justify-between gap-3 pl-5 text-xs">
        <span class="flex items-center gap-1.5 min-w-0">
          <span class="w-2 h-2 shrink-0 rounded-full {memberDisplay.dot}" title={memberDisplay.label}></span>
          <span class="wrap-break-word">{member.node}{member.cards > 1 ? `, ${member.cards} cards` : ""}</span>
        </span>
        <span class="shrink-0 text-muted-foreground">
          {formatMemory(member.gpuGb, member.hostGb, member.sharedMemory)}
        </span>
      </div>
      {#if member.error}
        <p class="pl-8 text-xs text-destructive">{member.error}</p>
      {/if}
    {/each}
    {#if replica.error && !(replica.members ?? []).some((member) => member.error)}
      <p class="pl-5 text-xs text-destructive">{replica.error}</p>
    {/if}
    {#each replica.couplingIssues ?? [] as issue}
      <p class="flex items-start gap-1 pl-5 text-xs text-amber-700 dark:text-amber-500">
        <TriangleAlert class="w-3 h-3 mt-px shrink-0" aria-hidden="true" />Coupling: {issue.text}
        <a href={issue.docsUrl} target="_blank" rel="noopener noreferrer" title="How to fix this" aria-label="How to fix this" class="text-muted-foreground hover:text-amber-700">
          <Info class="w-3 h-3 mt-px shrink-0" />
        </a>
      </p>
    {/each}
  </li>
{/snippet}

{#if deployment.status}
  {@const status = deployment.status}
  {@const failing = ["failed", "partial", "degraded"].includes(status.phase)}
  <p class="text-sm text-muted-foreground">
    {replicaSlotCounts(models).map(([phase, count]) => `${count} ${SLOT_DISPLAY[phase].label.toLowerCase()}`).join(" · ")}
  </p>
  <ul class="mt-2 divide-y rounded-lg border text-sm">
    {#each models as model (model.side ?? model.specifier)}
      {#if models.length > 1}
        <li class="flex justify-between gap-3 bg-muted/40 px-3 py-1.5 text-xs font-medium">
          <span class="min-w-0 wrap-break-word">{titleOf(model)}</span>
          <span class="shrink-0 text-muted-foreground">{model.observed.length} of {model.observed.length + model.missing} placed</span>
        </li>
      {/if}
      {#each model.observed as replica, index (index)}
        {@render replicaRow(replica)}
      {/each}
      {#each { length: model.missing } as _, index (index)}
        {@render unplacedRow()}
      {/each}
    {/each}
  </ul>
  {#if status.progress != null}
    <div title="{Math.round(status.progress * 100)}%" class="w-full bg-muted rounded-full h-2 mt-2">
      <div class="bg-primary h-2 rounded-full transition-all" style="width: {status.progress * 100}%"></div>
    </div>
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
{:else}
  <p class="text-sm text-muted-foreground">Nothing has been placed yet.</p>
{/if}
