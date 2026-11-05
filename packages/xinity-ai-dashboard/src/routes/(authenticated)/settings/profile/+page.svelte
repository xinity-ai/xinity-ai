<script lang="ts">
  import type { PageData } from "./$types";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import SettingsForm from "../SettingsForm.svelte";

  const { data }: { data: PageData } = $props();
</script>

<SettingsForm
  title="Profile Settings"
  description="Manage your account information"
  user={data.fullUser}
  fields={["image", "name"]}
>
  {#snippet children(settings)}
    <div class="space-y-2">
      <Label for="name">Name</Label>
      <Input
        type="text"
        id="name"
        bind:value={settings.name}
        placeholder="Your name"
      />
    </div>

    <div class="space-y-2">
      <Label for="email">Email</Label>
      <Input
        type="email"
        id="email"
        value={settings.email}
        readonly
        disabled
        class="bg-muted"
      />
      <p class="text-xs text-muted-foreground">Email cannot be changed</p>
    </div>
  {/snippet}
</SettingsForm>
