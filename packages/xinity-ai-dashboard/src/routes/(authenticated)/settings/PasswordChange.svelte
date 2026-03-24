<script lang="ts">
  import { orpc } from "$lib/orpc/orpc-client";
  import { toastState } from "$lib/state/toast.svelte";

  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Loader2, Lock } from "@lucide/svelte";

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
    const [error] = await orpc.auth.changePassword({
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
    }
  }
</script>

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
