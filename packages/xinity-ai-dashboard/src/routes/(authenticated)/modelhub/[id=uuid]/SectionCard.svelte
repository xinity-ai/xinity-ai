<script lang="ts">
  import { tick, untrack } from "svelte";
  import { Pencil } from "@lucide/svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Button } from "$lib/components/ui/button";
  import { changedFields, partsOf, patchOf, type SectionComponent, type SectionContext, type SectionDraft } from "$lib/components/deployments/sections/deployment-sections";
  import PanelCard from "$lib/components/deployments/PanelCard.svelte";

  let {
    deployment,
    title,
    component: Section,
    fields,
    context,
    onSaved,
  }: {
    deployment: SectionDraft;
    title: string;
    component: SectionComponent;
    fields: readonly string[];
    context: SectionContext;
    onSaved: () => Promise<void>;
  } = $props();

  // Every member carries settings, so the settings fields bind to an object from the start.
  function draftOf(source: SectionDraft): SectionDraft {
    const copy = $state.snapshot(source) as SectionDraft;
    for (const { member } of partsOf(copy).members) {
      member.settings ??= { version: 1 };
    }
    return copy;
  }

  let draft = $state(untrack(() => draftOf(deployment)));
  let base = $state(untrack(() => draftOf(deployment)));
  let editing = $state(false);
  let saving = $state(false);
  let blocked = $state(false);
  let editButton = $state<HTMLElement | null>(null);
  let error = $state<string | null>(null);
  let form = $state<HTMLElement | null>(null);

  const changed = $derived(changedFields(draft, base, fields));

  // A newer deployment replaces the draft unless it has edits, which stay until saved or cancelled.
  $effect(() => {
    const latest = draftOf(deployment);
    if (untrack(() => changed.length === 0)) {
      draft = draftOf(latest);
    }
    base = latest;
  });

  export async function startEditing() {
    editing = true;
    await tick();
    form?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    form?.querySelector<HTMLElement>("input, select, textarea")?.focus();
  }

  async function stopEditing() {
    editing = false;
    await tick();
    editButton?.focus();
  }

  function cancel() {
    draft = draftOf(base);
    error = null;
    void stopEditing();
  }

  function cancelOnEscape(event: KeyboardEvent) {
    if (event.key === "Escape" && editing && !saving) {
      event.stopPropagation();
      cancel();
    }
  }

  async function save() {
    saving = true;
    error = null;
    const [err] = await orpc.deployments.update(patchOf(draft, changed));
    saving = false;
    if (err) {
      error = err.message;
      return;
    }
    await stopEditing();
    await onSaved();
  }
</script>

<PanelCard {title} class={editing ? "lg:col-span-full" : ""}>
  {#snippet actions()}
    {#if context.canEdit && !editing}
      <Button bind:ref={editButton} variant="ghost" size="sm" class="h-7" onclick={startEditing} aria-label="Edit {title.toLowerCase()}">
        <Pencil class="w-3.5 h-3.5" />
        Edit
      </Button>
    {/if}
  {/snippet}
  <!-- Escape leaves edit mode from any field inside, as it closes a dialog. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div bind:this={form} class="space-y-4 compact:space-y-3" onkeydown={cancelOnEscape}>
    <Section bind:draft bind:blocked {context} {editing} changed={changed.length > 0} />
    {#if editing}
      <div class="flex flex-wrap items-center justify-end gap-3 pt-3 border-t">
        {#if error}
          <p class="mr-auto text-sm text-destructive">{error}</p>
        {/if}
        <Button variant="outline" size="sm" onclick={cancel} disabled={saving}>Cancel</Button>
        <Button size="sm" onclick={save} disabled={saving || changed.length === 0 || blocked}>Save</Button>
      </div>
    {/if}
  </div>
</PanelCard>
