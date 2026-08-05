<script lang="ts">
  import type { ModelV2WithSpecifier } from "xinity-infoserver";
  import type { DeploymentSettings } from "common-db/deployment-settings";
  import { DeploymentSettingsDto } from "$lib/orpc/dtos/model.dto";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";

  let {
    settings = $bindable<DeploymentSettings>({ version: 1 }),
    selectedPrimaryModel,
    idSuffix = "",
  }: {
    settings: DeploymentSettings;
    selectedPrimaryModel: ModelV2WithSpecifier | undefined;
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

  <div class="space-y-2 mt-4">
    <Label for="max-audio-file-size{idSuffix}">Maximum Audio Input File Size (MB)</Label>
    <Input
      id="max-audio-file-size{idSuffix}"
      type="number" min="1" step="1"
      value={settings.maxAudioInputFileSizeMB ?? ""}
      oninput={(e) => {
        const val = e.currentTarget.value === "" ? undefined : e.currentTarget.valueAsNumber;
        settings = { ...settings, maxAudioInputFileSizeMB: val };
      }}
      placeholder="25"
    />
    {#if !validationResult.success && settings.maxAudioInputFileSizeMB != null}
      <p class="text-sm text-destructive">Must be a whole number greater than or equal to 1.</p>
    {:else}
      <p class="text-sm text-muted-foreground">
        Maximum upload size for audio files in megabytes.
        Leave empty for the engine default (25 MB).
      </p>
    {/if}
  </div>
{/if}
