<script lang="ts">
  import type { ModelWithSpecifier } from "xinity-infoserver";
  import type { DeploymentSettings } from "common-db";
  import { DeploymentSettingsDto } from "$lib/orpc/dtos/model.dto";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";

  let {
    settings = $bindable<DeploymentSettings>({ version: 1 }),
    selectedPrimaryModel,
    idSuffix = "",
  }: {
    settings: DeploymentSettings;
    selectedPrimaryModel: ModelWithSpecifier | undefined;
    idSuffix?: string;
  } = $props();

  const isTranscription = $derived(selectedPrimaryModel?.type === "transcription");
  const validationResult = $derived(DeploymentSettingsDto.safeParse(settings));
</script>

{#if isTranscription}
  <div class="space-y-2">
    <Label for="max-audio-duration{idSuffix}">Maximum Audio Input Duration (seconds)</Label>
    <Input
      id="max-audio-duration{idSuffix}"
      type="number" min="1" step="1"
      value={settings.maxAudioInputDurationS ?? ""}
      oninput={(e) => {
        const val = e.currentTarget.value === "" ? undefined : e.currentTarget.valueAsNumber;
        settings = { ...settings, maxAudioInputDurationS: val };
      }}
      placeholder="600"
    />
    {#if !validationResult.success && settings.maxAudioInputDurationS != null}
      <p class="text-sm text-destructive">Must be a whole number between 1 and 86,400.</p>
    {:else}
      <p class="text-sm text-muted-foreground">
        Maximum expected duration of incoming audio in seconds.
        Leave empty for the engine default (600 seconds).
      </p>
    {/if}
  </div>
{/if}
