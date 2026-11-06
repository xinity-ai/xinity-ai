<script lang="ts">
  import type { PageData } from "./$types";
  import type { User } from "common-db";
  import { Switch } from "$lib/components/ui/switch";
  import { Label } from "$lib/components/ui/label";
  import { Separator } from "$lib/components/ui/separator";
  import SettingsForm from "../SettingsForm.svelte";

  const { data }: { data: PageData } = $props();

  type NotificationKey = keyof User["notificationSettings"];
  const notificationToggles: Array<{ id: string; label: string; description: string; field: NotificationKey }> = [
    { id: "email-notifications", label: "Email Notifications", description: "Receive notifications via email", field: "emailNotifications" },
    { id: "training-alerts", label: "Model Training Alerts", description: "Get notified when model training completes", field: "modelTrainingAlerts" },
    { id: "weekly-reports", label: "Weekly Reports", description: "Receive weekly usage summaries", field: "weeklyReports" },
    { id: "api-alerts", label: "API Usage Alerts", description: "Get notified about API usage thresholds", field: "apiUsageAlerts" },
  ];
</script>

<SettingsForm
  title="Notification Settings"
  description="Configure how you receive notifications"
  user={data.fullUser}
  fields={["notificationSettings"]}
>
  {#snippet children(settings)}
    {#each notificationToggles as toggle, i (toggle.id)}
      {#if i > 0}<Separator />{/if}
      <div class="flex items-center justify-between">
        <div class="space-y-0.5">
          <Label for={toggle.id}>{toggle.label}</Label>
          <p class="text-sm text-muted-foreground">{toggle.description}</p>
        </div>
        <Switch
          id={toggle.id}
          bind:checked={settings.notificationSettings[toggle.field]}
        />
      </div>
    {/each}
  {/snippet}
</SettingsForm>
