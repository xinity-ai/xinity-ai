<script lang="ts">
  import type { PageData } from "./$types";
  import { orpc } from "$lib/orpc/orpc-client";
  import { pick } from "$lib/util";
  import { toastState } from "$lib/state/toast.svelte";
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
      pick(userSettings, "notificationSettings"),
    );
    if (error) {
      toastState.add(error.message, "error");
    } else {
      toastState.add("Settings saved successfully", "success");
    }

    isSaving = false;
  }
</script>

<div class="space-y-6">
  <div>
    <h2 class="text-lg font-semibold tracking-tight">Notification Settings</h2>
    <p class="text-sm text-muted-foreground">Configure how you receive notifications</p>
  </div>

  <Separator />

  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <div class="space-y-0.5">
        <Label for="email-notifications">Email Notifications</Label>
        <p class="text-sm text-muted-foreground">Receive notifications via email</p>
      </div>
      <Switch
        id="email-notifications"
        checked={userSettings.notificationSettings.emailNotifications}
        onCheckedChange={(checked) => userSettings.notificationSettings.emailNotifications = checked}
      />
    </div>

    <Separator />

    <div class="flex items-center justify-between">
      <div class="space-y-0.5">
        <Label for="training-alerts">Model Training Alerts</Label>
        <p class="text-sm text-muted-foreground">Get notified when model training completes</p>
      </div>
      <Switch
        id="training-alerts"
        checked={userSettings.notificationSettings.modelTrainingAlerts}
        onCheckedChange={(checked) => userSettings.notificationSettings.modelTrainingAlerts = checked}
      />
    </div>

    <Separator />

    <div class="flex items-center justify-between">
      <div class="space-y-0.5">
        <Label for="weekly-reports">Weekly Reports</Label>
        <p class="text-sm text-muted-foreground">Receive weekly usage summaries</p>
      </div>
      <Switch
        id="weekly-reports"
        checked={userSettings.notificationSettings.weeklyReports}
        onCheckedChange={(checked) => userSettings.notificationSettings.weeklyReports = checked}
      />
    </div>

    <Separator />

    <div class="flex items-center justify-between">
      <div class="space-y-0.5">
        <Label for="api-alerts">API Usage Alerts</Label>
        <p class="text-sm text-muted-foreground">Get notified about API usage thresholds</p>
      </div>
      <Switch
        id="api-alerts"
        checked={userSettings.notificationSettings.apiUsageAlerts}
        onCheckedChange={(checked) => userSettings.notificationSettings.apiUsageAlerts = checked}
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
