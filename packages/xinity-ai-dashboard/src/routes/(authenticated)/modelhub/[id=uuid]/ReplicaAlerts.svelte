<script lang="ts">
  import { CircleAlert, ExternalLink, Info, Pencil, RotateCcw, TriangleAlert } from "@lucide/svelte";
  import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
  import { Button } from "$lib/components/ui/button";
  import { capacityPreview, capacityRequestOf } from "$lib/components/deployments/sections/capacity-preview.svelte";
  import { modelSlots } from "./replica-slots";
  import { shortfallFix } from "$lib/components/deployments/status-display";

  let {
    deployment,
    canEdit,
    waitingNote,
    onRetry,
    onEditReplicas,
  }: {
    deployment: DeploymentOutput;
    canEdit: boolean;
    waitingNote: string | null;
    onRetry: () => void;
    onEditReplicas?: () => void;
  } = $props();

  const models = $derived(deployment.status ? modelSlots(deployment.status.wanted, deployment.status.replicas ?? []) : []);
  const unplaced = $derived(models.reduce((sum, model) => sum + model.missing, 0));
  const wanted = $derived(deployment.status?.wanted.reduce((sum, model) => sum + model.replicas, 0) ?? 0);
  const failed = $derived((deployment.status?.replicas ?? []).filter((replica) => replica.phase === "failed").length);
  const waitsForMachine = $derived(deployment.enabled && (!deployment.status || unplaced > 0));
  const down = $derived(deployment.status?.phase === "down");
  const raised = $derived(!deployment.status || down || deployment.status.phase === "degraded");

  // Why replicas wait is what the scheduler would say planning the deployment now. Kept as a string so only a change to
  // the deployment or to whether replicas wait asks again, not every refresh.
  const waitingQuestion = $derived(waitsForMachine ? JSON.stringify(capacityRequestOf(deployment, deployment.id)) : null);
  const waiting = capacityPreview(() => waitingQuestion && JSON.parse(waitingQuestion));
  const fix = $derived(waiting.result?.reasonCode ? shortfallFix(waiting.result.reasonCode) : null);
</script>

{#if deployment.enabled && (failed > 0 || deployment.status?.phase === "failed")}
  <div class="mb-3 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md bg-destructive/5 px-3 py-2 text-sm">
    <CircleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
    <div class="min-w-0 flex-1 basis-64">
      <span class="font-medium">{failed > 1 ? `${failed} replicas failed.` : "A replica failed."}</span>
      {deployment.status?.error ?? ""}
      <a href="/docs/deployment-troubleshooting/" class="text-muted-foreground underline underline-offset-2 hover:no-underline">Troubleshooting guide</a>
    </div>
    {#if canEdit}
      <Button variant="outline" size="sm" class="h-7" onclick={onRetry}>
        <RotateCcw class="h-3.5 w-3.5" />
        Retry
      </Button>
    {/if}
  </div>
{/if}

{#snippet fixText()}
  {#if fix}
    {fix.text}
    {#if fix.link}
      <a href={fix.link.href} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline">
        {fix.link.label}<ExternalLink class="h-3 w-3" aria-hidden="true" />
      </a>
    {/if}
  {/if}
{/snippet}

{#snippet missingCount()}
  {unplaced} of {wanted} {wanted === 1 ? "replica has" : "replicas have"} no machine.
{/snippet}

<!-- Missing replicas beside ones that serve leave the deployment serving, so they are noted rather than raised. A rollout
  side with none serving is raised, since its traffic share cannot be kept, and so is one with nothing reachable. -->
{#if waitsForMachine && waiting.result?.reason && !raised}
  <div class="mb-3 flex flex-wrap items-start gap-x-3 gap-y-2 text-sm text-muted-foreground">
    <Info class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    <p class="min-w-0 flex-1 basis-64">
      {@render missingCount()} {waiting.result.reason}.
      {waitingNote ?? ""}
      {@render fixText()}
    </p>
    {#if canEdit && fix?.fewerReplicasHelp && onEditReplicas}
      <Button variant="outline" size="sm" class="h-7" onclick={onEditReplicas}>
        <Pencil class="h-3.5 w-3.5" />
        Edit replicas
      </Button>
    {/if}
  </div>
{:else if waitsForMachine && (waiting.result?.reason || down)}
  <div class="mb-3 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md px-3 py-2 text-sm {down ? 'bg-destructive/5' : 'bg-amber-50 dark:bg-amber-500/10'}">
    {#if down}
      <CircleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
    {:else}
      <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
    {/if}
    <div class="min-w-0 flex-1 basis-64 space-y-1">
      <p>
        <span class="font-medium">
          {#if down}No replica is reachable. The machines it ran on went offline.{:else if deployment.status}{@render missingCount()}{:else}No machine yet.{/if}
        </span>
        {#if waiting.result?.reason}{waiting.result.reason}.{/if}
        {#if deployment.status && !down}{waitingNote ?? ""}{/if}
      </p>
      {#if fix}
        <p class="text-muted-foreground">
          {@render fixText()}
          {#if fix.resolvesOnItsOwn && !deployment.status}
            Disable the deployment if it should not wait.
          {/if}
        </p>
      {/if}
    </div>
    {#if canEdit && fix?.fewerReplicasHelp && onEditReplicas}
      <Button variant="outline" size="sm" class="h-7" onclick={onEditReplicas}>
        <Pencil class="h-3.5 w-3.5" />
        Edit replicas
      </Button>
    {/if}
  </div>
{/if}
