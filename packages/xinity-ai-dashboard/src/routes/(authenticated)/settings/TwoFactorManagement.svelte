<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { twoFactor } from "$lib/auth";
  import { toastState } from "$lib/state/toast.svelte";

  import TwoFactorSetup from "./TwoFactorSetup.svelte";
  import BackupCodesDisplay from "./BackupCodesDisplay.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Loader2, ShieldCheck, ShieldOff } from "@lucide/svelte";

  let { twoFactorEnabled = false }: { twoFactorEnabled: boolean } = $props();

  type View = "idle" | "setup" | "disabling" | "regenerating" | "showingCodes";

  let view = $state<View>("idle");
  let password = $state("");
  let errorMessage = $state("");
  let isSubmitting = $state(false);
  let backupCodes = $state<string[]>([]);

  function reset() {
    view = "idle";
    password = "";
    errorMessage = "";
    isSubmitting = false;
    backupCodes = [];
  }

  async function handleDisable() {
    errorMessage = "";
    isSubmitting = true;

    const res = await twoFactor.disable({ password });
    isSubmitting = false;

    if (res.error) {
      errorMessage = res.error.message ?? "Failed to disable two-factor authentication";
      return;
    }

    toastState.add("Two-factor authentication disabled", "success");
    reset();
    invalidateAll();
  }

  async function handleRegenerateBackupCodes() {
    errorMessage = "";
    isSubmitting = true;

    const res = await twoFactor.generateBackupCodes({ password });
    isSubmitting = false;

    if (res.error) {
      errorMessage = res.error.message ?? "Failed to regenerate backup codes";
      return;
    }

    backupCodes = res.data?.backupCodes ?? [];
    password = "";
    view = "showingCodes";
  }
</script>

<div class="space-y-4 max-w-md">
  {#if view === "setup"}
    <TwoFactorSetup onComplete={reset} onCancel={reset} />

  {:else if twoFactorEnabled && view === "idle"}
    <div class="flex items-start gap-3 rounded-md border border-green-500/30 bg-green-500/10 p-4">
      <ShieldCheck class="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
      <div class="text-sm">
        <p class="font-medium text-green-600 dark:text-green-400">Two-factor authentication is enabled</p>
        <p class="text-muted-foreground">Your account is protected with an authenticator app.</p>
      </div>
    </div>

    <div class="flex gap-2">
      <Button variant="outline" size="sm" onclick={() => (view = "regenerating")}>
        Regenerate Backup Codes
      </Button>
      <Button variant="destructive" size="sm" onclick={() => (view = "disabling")}>
        <ShieldOff class="w-4 h-4" />
        Disable
      </Button>
    </div>

  {:else if !twoFactorEnabled && view === "idle"}
    <p class="text-sm text-muted-foreground">
      Add an extra layer of security by requiring a code from your authenticator app when signing in.
    </p>
    <Button onclick={() => (view = "setup")}>
      <ShieldCheck class="w-4 h-4" />
      Enable Two-Factor Authentication
    </Button>

  {:else if view === "disabling"}
    <form
      onsubmit={(e) => { e.preventDefault(); handleDisable(); }}
      class="space-y-4"
    >
      <p class="text-sm text-muted-foreground">
        Enter your password to disable two-factor authentication.
        This will remove the authenticator app requirement from your account.
      </p>
      <div class="space-y-2">
        <Label for="2fa-disable-password">Password</Label>
        <Input
          id="2fa-disable-password"
          type="password"
          required
          bind:value={password}
          placeholder="Enter your password"
        />
      </div>

      {#if errorMessage}
        <p class="text-sm text-destructive">{errorMessage}</p>
      {/if}

      <div class="flex gap-2">
        <Button variant="outline" type="button" onclick={reset}>Cancel</Button>
        <Button variant="destructive" type="submit" disabled={isSubmitting}>
          {#if isSubmitting}
            <Loader2 class="w-4 h-4 animate-spin" />
            Disabling...
          {:else}
            Disable Two-Factor Authentication
          {/if}
        </Button>
      </div>
    </form>

  {:else if view === "regenerating"}
    <form
      onsubmit={(e) => { e.preventDefault(); handleRegenerateBackupCodes(); }}
      class="space-y-4"
    >
      <p class="text-sm text-muted-foreground">
        Enter your password to generate new backup codes. This will invalidate all existing backup codes.
      </p>
      <div class="space-y-2">
        <Label for="2fa-regen-password">Password</Label>
        <Input
          id="2fa-regen-password"
          type="password"
          required
          bind:value={password}
          placeholder="Enter your password"
        />
      </div>

      {#if errorMessage}
        <p class="text-sm text-destructive">{errorMessage}</p>
      {/if}

      <div class="flex gap-2">
        <Button variant="outline" type="button" onclick={reset}>Cancel</Button>
        <Button type="submit" disabled={isSubmitting}>
          {#if isSubmitting}
            <Loader2 class="w-4 h-4 animate-spin" />
            Regenerating...
          {:else}
            Regenerate
          {/if}
        </Button>
      </div>
    </form>

  {:else if view === "showingCodes"}
    <BackupCodesDisplay
      codes={backupCodes}
      description="Your new backup codes are shown below. Previous codes are no longer valid. Save these in a safe place."
    />
    <Button size="sm" onclick={reset}>Done</Button>
  {/if}
</div>
