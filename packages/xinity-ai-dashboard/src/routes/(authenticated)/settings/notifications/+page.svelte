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

  type NotificationKey = keyof User["notificationSettings"];
  const notificationToggles: Array<{ id: string; label: string; description: string; field: NotificationKey }> = [
    { id: "email-notifications", label: "Email Notifications", description: "Receive notifications via email", field: "emailNotifications" },
    { id: "training-alerts", label: "Model Training Alerts", description: "Get notified when model training completes", field: "modelTrainingAlerts" },
    { id: "weekly-reports", label: "Weekly Reports", description: "Receive weekly usage summaries", field: "weeklyReports" },
    { id: "api-alerts", label: "API Usage Alerts", description: "Get notified about API usage thresholds", field: "apiUsageAlerts" },
  ];

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
    {#each notificationToggles as toggle, i (toggle.id)}
      {#if i > 0}<Separator />{/if}
      <div class="flex items-center justify-between">
        <div class="space-y-0.5">
          <Label for={toggle.id}>{toggle.label}</Label>
          <p class="text-sm text-muted-foreground">{toggle.description}</p>
        </div>
        <Switch
          id={toggle.id}
          bind:checked={userSettings.notificationSettings[toggle.field]}
        />
      </div>
    {/each}
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
