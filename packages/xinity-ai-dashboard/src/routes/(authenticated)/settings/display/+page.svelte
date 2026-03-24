<script lang="ts">
  import type { PageData } from "./$types";
  import { orpc } from "$lib/orpc/orpc-client";
  import { pick } from "$lib/util";
  import { toastState } from "$lib/state/toast.svelte";
  import { invalidateAll } from "$app/navigation";
  import type { User } from "common-db";

  // shadcn components
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import { Label } from "$lib/components/ui/label";
  import { Separator } from "$lib/components/ui/separator";

  // Icons
  import { Loader2 } from "@lucide/svelte";

  const { data }: { data: PageData } = $props();

  // Use $state instead of $derived so we can mutate
  // svelte-ignore state_referenced_locally
  let userSettings = $state<User>(structuredClone(data.fullUser));
  let isSaving = $state(false);

  // Sync when data changes from server
  $effect(() => {
    userSettings = structuredClone(data.fullUser);
  });

  async function saveSettings() {
    isSaving = true;

    const [error] = await orpc.user.updateSettings(
      pick(userSettings, "displaySettings"),
    );
    if (error) {
      toastState.add(error.message, "error");
    } else {
      toastState.add("Settings saved successfully", "success");
      await invalidateAll();
    }

    isSaving = false;
  }
</script>

<div class="space-y-6">
  <div>
    <h2 class="text-lg font-semibold tracking-tight">Display Settings</h2>
    <p class="text-sm text-muted-foreground">Customize the appearance of the dashboard</p>
  </div>

  <Separator />

  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <div class="space-y-0.5">
        <Label for="compact-view">Compact View</Label>
        <p class="text-sm text-muted-foreground">Use a more compact layout with less spacing</p>
      </div>
      <Switch
        id="compact-view"
        checked={userSettings.displaySettings.compactView}
        onCheckedChange={(checked) => userSettings.displaySettings.compactView = checked}
      />
    </div>
  </div>

  <Separator />

  <div class="flex gap-3">
    <Button onclick={saveSettings} disabled={isSaving}>
      {#if isSaving}
        <Loader2 class="w-4 h-4 animate-spin" />
        Saving...
      {:else}
        Save Settings
      {/if}
    </Button>
  </div>
</div>
