<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { orpc } from "$lib/orpc/orpc-client";
  import { toastState } from "$lib/state/toast.svelte";

  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Loader2, Lock, AlertTriangle } from "@lucide/svelte";

  let { temporaryPassword = false }: { temporaryPassword?: boolean } = $props();

  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let isSubmitting = $state(false);
  let errorMessage = $state("");

  async function handleSubmit() {
    errorMessage = "";

    if (newPassword !== confirmPassword) {
      errorMessage = "Passwords do not match";
      return;
    }

    isSubmitting = true;
    const [error] = await orpc.account.changePassword({
      currentPassword,
      newPassword,
    });
    isSubmitting = false;

    if (error) {
      errorMessage = error.message;
    } else {
      toastState.add("Password changed successfully", "success");
      currentPassword = "";
      newPassword = "";
      confirmPassword = "";
      invalidateAll();
    }
  }
</script>

{#if temporaryPassword}
  <div class="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-4 mb-4 max-w-md">
    <AlertTriangle class="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
    <div class="text-sm">
      <p class="font-medium text-amber-500">Temporary password</p>
      <p class="text-muted-foreground">You are using a temporary password. Please set a new password to continue.</p>
    </div>
  </div>
{/if}

<form
    onsubmit={(e) => {
      e.preventDefault();
      handleSubmit();
    }}
    class="space-y-4 max-w-md"
  >
    <div class="space-y-2">
      <Label for="current-password">Current Password</Label>
      <Input
        id="current-password"
        type="password"
        required
        bind:value={currentPassword}
        placeholder="Enter current password"
      />
    </div>

    <div class="space-y-2">
      <Label for="new-password">New Password</Label>
      <Input
        id="new-password"
        type="password"
        required
        minlength={8}
        bind:value={newPassword}
        placeholder="Enter new password (min. 8 characters)"
      />
    </div>

    <div class="space-y-2">
      <Label for="confirm-password">Confirm New Password</Label>
      <Input
        id="confirm-password"
        type="password"
        required
        minlength={8}
        bind:value={confirmPassword}
        placeholder="Confirm new password"
      />
    </div>

    {#if errorMessage}
      <p class="text-sm text-destructive">{errorMessage}</p>
    {/if}

    <Button type="submit" disabled={isSubmitting}>
      {#if isSubmitting}
        <Loader2 class="w-4 h-4 animate-spin" />
        Changing...
      {:else}
        <Lock class="w-4 h-4" />
        Change Password
      {/if}
    </Button>
  </form>
