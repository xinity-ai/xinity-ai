<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import { CircleCheck, SlidersHorizontal, Undo2 } from "@lucide/svelte";
  import type { CANARY_MEMBERS, DeploymentOf } from "$lib/orpc/dtos/model.dto";
  import { orpc } from "$lib/orpc/orpc-client";
  import { toastState } from "$lib/state/toast.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import AdvanceInput from "./AdvanceInput.svelte";
  import type { PanelContext } from "./deployment-views";
  import PanelCard from "$lib/components/deployments/PanelCard.svelte";
  import { advanceDraftOf, advanceInputOf, type AdvanceDraft } from "$lib/components/deployments/rollout-advance";

  let {
    deployment,
    context,
    promotable,
    promoteBlockedBy,
    children,
  }: {
    deployment: DeploymentOf<"canary">;
    context: PanelContext;
    promotable: boolean;
    /** Says why Promote is unavailable, for assistive technology. */
    promoteBlockedBy?: string;
    children: Snippet;
  } = $props();

  type Member = (typeof CANARY_MEMBERS)[number];

  const nameOf = (specifier: string) => context.models.get(specifier)?.name ?? specifier;

  let progress = $state(untrack(() => deployment.canary.progress));
  let advance = $state<AdvanceDraft>(untrack(() => advanceDraftOf(deployment.canary.advance)));
  let saving = $state(false);
  let adjusting = $state(false);
  let advanceInvalid = $state(false);
  let form = $state<HTMLElement | null>(null);
  let adjustButton = $state<HTMLElement | null>(null);
  let confirming = $state<Member | null>(null);

  // A draft counts hours from now, so it is taken once per stored advance. Taken again on every refresh, its hours would drift
  // from what the form holds and read as an edit nobody made.
  const storedAdvanceKey = $derived(JSON.stringify(deployment.canary.advance));
  const storedAdvance = $derived(JSON.stringify(advanceDraftOf(JSON.parse(storedAdvanceKey))));
  const progressChanged = $derived(progress !== deployment.canary.progress);
  const advanceChanged = $derived(JSON.stringify(advance) !== storedAdvance);
  const progressError = $derived(Number.isInteger(progress) && progress >= 0 && progress <= 100 ? null : "Give a whole number from 0 to 100.");

  // The sync moves progress under a time-based advance, so the control follows it until edited.
  $effect(() => {
    const latest = deployment.canary.progress;
    const latestAdvance = storedAdvance;
    if (untrack(() => !progressChanged && !advanceChanged)) {
      progress = latest;
      advance = JSON.parse(latestAdvance);
    }
  });

  async function apply() {
    saving = true;
    const [err] = await orpc.deployments.update({
      id: deployment.id,
      canary: {
        ...(progressChanged ? { progress } : {}),
        ...(advanceChanged ? { advance: advanceInputOf(advance) } : {}),
      },
    });
    saving = false;
    if (err) {
      toastState.add(`Failed to change the rollout: ${err.message}`, "error");
      return;
    }
    adjusting = false;
    await context.onChanged();
  }

  async function startAdjusting() {
    adjusting = true;
    await tick();
    form?.querySelector<HTMLElement>("input")?.focus();
  }

  async function stopAdjusting() {
    progress = deployment.canary.progress;
    advance = JSON.parse(storedAdvance);
    adjusting = false;
    await tick();
    adjustButton?.focus();
  }

  function stopOnEscape(event: KeyboardEvent) {
    if (event.key === "Escape" && !saving) {
      event.stopPropagation();
      void stopAdjusting();
    }
  }

  const ENDINGS: Record<Member, { title: string; describe: () => string; label: string; done: () => string }> = {
    to: {
      title: "Promote the new model",
      describe: () =>
        `${nameOf(deployment.canary.to.specifier)} takes all ${deployment.canary.replicas} ${deployment.canary.replicas === 1 ? "replica" : "replicas"} and all traffic. `
        + `${nameOf(deployment.canary.from.specifier)} is uninstalled and removed from the deployment.`,
      label: "Promote",
      done: () => `Promoted ${nameOf(deployment.canary.to.specifier)}`,
    },
    from: {
      title: "Roll back",
      describe: () =>
        `${nameOf(deployment.canary.from.specifier)} takes all traffic again. `
        + `${nameOf(deployment.canary.to.specifier)} is uninstalled and removed from the deployment.`,
      label: "Roll back",
      done: () => `Rolled back to ${nameOf(deployment.canary.from.specifier)}`,
    },
  };

  async function end(keep: Member) {
    confirming = null;
    const [err] = await orpc.deployments.rollout({ id: deployment.id, type: "managed", managed: { keep } });
    if (err) {
      toastState.add(`Failed to end the rollout: ${err.message}`, "error");
      return;
    }
    toastState.add(ENDINGS[keep].done(), "success");
    await context.onChanged();
  }
</script>

<PanelCard title="Rollout">
  {#snippet actions()}
    {#if context.canEdit && !adjusting}
      <Button bind:ref={adjustButton} variant="ghost" size="sm" class="h-7" onclick={startAdjusting}>
        <SlidersHorizontal class="w-3.5 h-3.5" />
        Adjust
      </Button>
      <Button variant="outline" size="sm" class="h-7" onclick={() => (confirming = "from")}>
        <Undo2 class="w-3.5 h-3.5" />
        Roll back
      </Button>
      <Button size="sm" class="h-7 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100" onclick={() => (confirming = "to")} disabled={!promotable} aria-describedby={promotable ? undefined : "promote-blocked"}>
        <CircleCheck class="w-3.5 h-3.5" />
        Promote
      </Button>
      {#if !promotable && promoteBlockedBy}
        <span id="promote-blocked" class="sr-only">{promoteBlockedBy}</span>
      {/if}
    {/if}
  {/snippet}

  {#if adjusting}
    <!-- Escape leaves the form from any field inside, as it closes a dialog. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div bind:this={form} class="space-y-4" onkeydown={stopOnEscape}>
      <div class="space-y-1.5">
        <label for="rollout-progress" class="text-sm font-medium">Traffic on {nameOf(deployment.canary.to.specifier)}</label>
        <div class="flex items-center gap-3">
          <input id="rollout-progress" type="range" min="0" max="100" step="1" bind:value={progress} class="w-full accent-primary cursor-pointer" />
          <Input type="number" min={0} max={100} step="1" bind:value={progress} class="h-8 w-20 shrink-0" aria-label="Share in percent" aria-invalid={Boolean(progressError)} />
        </div>
        {#if progressError}
          <p class="text-xs text-destructive">{progressError}</p>
        {:else if advance.type === "time"}
          <p class="text-xs text-muted-foreground">A new share moves on from there to 100%, keeping the end time.</p>
        {/if}
      </div>
      {#if progress < 100}
        <div class="space-y-1.5">
          <p class="text-sm font-medium">Then move traffic</p>
          <AdvanceInput bind:advance bind:invalid={advanceInvalid} idSuffix="-rollout" />
        </div>
      {:else}
        <p class="text-sm text-muted-foreground">At 100% all traffic is on the new model. Promote it to finish the rollout.</p>
      {/if}
      <div class="flex flex-wrap items-center justify-end gap-3 border-t pt-3">
        <Button variant="outline" size="sm" onclick={() => void stopAdjusting()} disabled={saving}>Cancel</Button>
        <Button size="sm" onclick={apply} disabled={saving || Boolean(progressError) || (progress < 100 && advanceInvalid) || !(progressChanged || advanceChanged)}>Apply</Button>
      </div>
    </div>
  {:else}
    {@render children()}
  {/if}
</PanelCard>

{#if confirming}
  {@const ending = ENDINGS[confirming]}
  {@const keep = confirming}
  <ConfirmDialog
    open={true}
    title={ending.title}
    description={ending.describe()}
    confirmLabel={ending.label}
    onConfirm={() => void end(keep)}
    onCancel={() => (confirming = null)}
  />
{/if}
