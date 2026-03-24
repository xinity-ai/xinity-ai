<script lang="ts">
  import type { PageData } from "./$types";
  import { orpc } from "$lib/orpc/orpc-client";
  import { pick } from "$lib/util";
  import { toastState } from "$lib/state/toast.svelte";
  import type { User } from "common-db";

  // shadcn components
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Separator } from "$lib/components/ui/separator";

  // Icons
  import { Loader2 } from "@lucide/svelte";

  const { data }: { data: PageData } = $props();

  let userSettings: User = $derived(data.fullUser);
  let isSaving = $state(false);

  async function saveSettings() {
    isSaving = true;

    const [error] = await orpc.user.updateSettings(
      pick(userSettings, "image", "name"),
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
    <h2 class="text-lg font-semibold tracking-tight">Profile Settings</h2>
    <p class="text-sm text-muted-foreground">Manage your account information</p>
  </div>

  <Separator />

  <div class="space-y-4">
    <div class="space-y-2">
      <Label for="name">Name</Label>
      <Input
        type="text"
        id="name"
        bind:value={userSettings.name}
        placeholder="Your name"
      />
    </div>

    <div class="space-y-2">
      <Label for="email">Email</Label>
      <Input
        type="email"
        id="email"
        value={userSettings.email}
        readonly
        disabled
        class="bg-muted"
      />
      <p class="text-xs text-muted-foreground">Email cannot be changed</p>
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
