<script lang="ts">
  import { resolveOptimizeFor, type DeploymentSettings } from "common-env/deployment-settings";
  import type { ModelWithSpecifier } from "common-env/model-catalog";
  import DeploymentSettingsSection from "./DeploymentSettingsSection.svelte";
  import { hasSettings, partsOf, type SectionProps } from "./deployment-sections";
  import { OPTIMIZATION_GOAL_DISPLAY } from "./optimization-goals";
  import SummaryList from "./SummaryList.svelte";

  let { draft = $bindable(), context, editing }: SectionProps = $props();

  function optimizedForRow(settings: DeploymentSettings | undefined): [string, string] {
    const { label, summary } = OPTIMIZATION_GOAL_DISPLAY[resolveOptimizeFor(settings)];
    return ["Optimized for", `${label}: ${summary}`];
  }

  function summaryOf(model: ModelWithSpecifier | null | undefined, settings: DeploymentSettings | undefined): [string, string][] {
    if (model === undefined) {
      return [["", "Loading the model…"]];
    }
    if (model === null) {
      return [["", "The catalog does not describe this model"]];
    }
    if (!hasSettings(model)) {
      return [["", "Nothing to set for this model"]];
    }
    return [
      ...(model.engine === "vllm" ? [optimizedForRow(settings)] : []),
      ...(model.type === "transcription"
        ? [
            ["Max audio length", settings?.maxAudioInputDurationS ? `${settings.maxAudioInputDurationS} s` : "Engine default"],
            ["Max audio file", settings?.maxAudioInputFileSizeMB ? `${settings.maxAudioInputFileSizeMB} MB` : "Engine default"],
          ] as [string, string][]
        : []),
    ];
  }
</script>

<div class="space-y-4">
  {#each partsOf(draft).members as { label, member }, index (index)}
    {@const model = context.models.get(member.specifier)}
    <div class="space-y-2">
      {#if label}
        <p class="text-sm wrap-break-word"><span class="text-muted-foreground">{label}:</span> <span class="font-medium">{model?.name ?? member.specifier}</span></p>
      {/if}
      {#if editing && model && hasSettings(model)}
        <DeploymentSettingsSection
          bind:settings={() => member.settings ?? { version: 1 }, (settings) => (member.settings = settings)}
          selectedPrimaryModel={model}
          idSuffix="-{index}"
        />
      {:else}
        <SummaryList rows={summaryOf(model, member.settings)} />
      {/if}
    </div>
  {/each}
</div>
