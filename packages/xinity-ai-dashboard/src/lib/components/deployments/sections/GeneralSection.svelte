<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { DeploymentBaseInputDto } from "$lib/orpc/dtos/model.dto";
  import type { SectionProps } from "./deployment-sections";
  import SummaryList from "./SummaryList.svelte";

  let { draft = $bindable(), context, editing, blocked = $bindable() }: SectionProps = $props();

  const nameError = $derived(draft.name.trim() ? null : "Give the deployment a name.");
  const publicSpecifierError = $derived(
    DeploymentBaseInputDto.shape.publicSpecifier.safeParse(draft.publicSpecifier).error?.issues[0]?.message
      ?? (context.takenPublicSpecifiers.includes(draft.publicSpecifier.trim()) ? "Another deployment already uses this public name" : null),
  );

  $effect(() => {
    blocked = Boolean(nameError || publicSpecifierError);
  });
</script>

{#if !editing}
  <SummaryList rows={[["Name", draft.name], ["Public name", draft.publicSpecifier]]} />
{:else}
  <div class="space-y-4">
    <div class="space-y-1.5">
      <Label for="deployment-name">Name</Label>
      <Input id="deployment-name" bind:value={draft.name} placeholder="e.g. Customer Support" aria-invalid={Boolean(nameError)} aria-describedby="deployment-name-error" />
      {#if nameError}
        <p id="deployment-name-error" class="text-xs text-destructive">{nameError}</p>
      {/if}
    </div>
    <div class="space-y-1.5">
      <Label for="public-specifier">Public name</Label>
      <Input id="public-specifier" bind:value={draft.publicSpecifier} placeholder="e.g. support-assistant" aria-invalid={Boolean(publicSpecifierError)} aria-describedby="public-specifier-hint" />
      <p id="public-specifier-hint" class="text-xs {publicSpecifierError ? 'text-destructive' : 'text-muted-foreground'}">
        {#if publicSpecifierError}
          {publicSpecifierError}.
        {:else}
          What API callers pass as the model. Letters, digits and . _ -, at least 5 characters.{context.creating ? "" : " Changing it breaks callers that use the old name."}
        {/if}
      </p>
    </div>
  </div>
{/if}
