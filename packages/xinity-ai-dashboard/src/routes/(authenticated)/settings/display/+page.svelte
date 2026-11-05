<script lang="ts">
  import type { PageData } from "./$types";
  import { refreshAll } from "$app/navigation";
  import { Switch } from "$lib/components/ui/switch";
  import { Label } from "$lib/components/ui/label";
  import SettingsForm from "../SettingsForm.svelte";

  const { data }: { data: PageData } = $props();
</script>

<SettingsForm
  title="Display Settings"
  description="Customize the appearance of the dashboard"
  user={data.fullUser}
  fields={["displaySettings"]}
  onSaved={refreshAll}
>
  {#snippet children(settings)}
    <div class="flex items-center justify-between">
      <div class="space-y-0.5">
        <Label for="compact-view">Compact View</Label>
        <p class="text-sm text-muted-foreground">Use a more compact layout with less spacing</p>
      </div>
      <Switch
        id="compact-view"
        bind:checked={settings.displaySettings.compactView}
      />
    </div>
  {/snippet}
</SettingsForm>
