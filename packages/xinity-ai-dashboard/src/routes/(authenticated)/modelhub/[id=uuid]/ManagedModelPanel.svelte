<script lang="ts">
  import { ArrowLeftRight } from "@lucide/svelte";
  import type { ModelWithSpecifier } from "common-env/model-catalog";
  import { Button } from "$lib/components/ui/button";
  import type { DeploymentOf } from "$lib/orpc/dtos/model.dto";
  import ChangeModelDialog from "./ChangeModelDialog.svelte";
  import type { PanelContext } from "./deployment-views";
  import ModelCard from "$lib/components/deployments/picker/ModelCard.svelte";
  import ModelSelectorModal from "$lib/components/deployments/picker/ModelSelectorModal.svelte";
  import PanelCard from "$lib/components/deployments/PanelCard.svelte";

  let { deployment, context }: { deployment: DeploymentOf<"managed">; context: PanelContext } = $props();

  // The picker keeps the deployment to the kind of model it serves, so it waits until that kind is known.
  const currentModel = $derived(context.models.get(deployment.managed.specifier));

  let picking = $state(false);
  let search = $state("");
  let target = $state<ModelWithSpecifier | null>(null);
</script>

<PanelCard title="Model">
  {#snippet actions()}
    {#if context.canEdit}
      <Button variant="ghost" size="sm" class="h-7" onclick={() => (picking = true)} disabled={currentModel === undefined} title={currentModel === undefined ? "Loading the current model" : undefined}>
        <ArrowLeftRight class="w-3.5 h-3.5" />
        Change model
      </Button>
    {/if}
  {/snippet}
  <ModelCard wide specifier={deployment.managed.specifier} preferredDriver={deployment.managed.preferredDriver} model={currentModel} />
</PanelCard>

<ModelSelectorModal
  bind:open={picking}
  bind:searchTerm={search}
  nodeCapabilities={context.nodeCapabilities}
  modelCompatibility={context.modelCompatibility}
  licensedVram={context.licensedVram}
  fixedType={currentModel?.type}
  current={deployment.managed.specifier}
  onSelect={(model) => {
    picking = false;
    target = model;
  }}
  onClose={() => (picking = false)}
/>

{#if target}
  <ChangeModelDialog
    {deployment}
    {target}
    {context}
    close={() => (target = null)}
    chooseAnother={() => {
      target = null;
      picking = true;
    }}
  />
{/if}
