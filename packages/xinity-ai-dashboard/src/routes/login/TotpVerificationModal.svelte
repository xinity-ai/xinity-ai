<script lang="ts">
  import { goto } from "$app/navigation";
  import { twoFactor } from "$lib/auth";

  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Loader2 } from "@lucide/svelte";

  let { open = $bindable(false), callbackUrl }: {
    open: boolean;
    callbackUrl: string;
  } = $props();

  let totpCode = $state("");
  let backupCode = $state("");
  let errorMessage = $state<string | undefined>();
  let isVerifying = $state(false);
  let showBackupCodeInput = $state(false);

  function resetAndClose() {
    open = false;
    totpCode = "";
    backupCode = "";
    errorMessage = undefined;
    showBackupCodeInput = false;
  }

  async function verify() {
    errorMessage = undefined;
    isVerifying = true;
    try {
      const res = showBackupCodeInput
        ? await twoFactor.verifyBackupCode({ code: backupCode })
        : await twoFactor.verifyTotp({ code: totpCode });

      if (res?.error) {
        errorMessage = res.error.message ?? "Verification failed";
        return;
      }
      await goto(callbackUrl);
    } catch (e) {
      errorMessage = (e as Error).message ?? "Unexpected error";
    } finally {
      isVerifying = false;
    }
  }
</script>

<Modal bind:open onClose={resetAndClose} class="max-w-sm">
  <div class="bg-card rounded-xl border shadow-2xl w-full p-6">
    <h2 class="mb-4 text-lg font-bold">Two-Factor Authentication</h2>
    <form
      onsubmit={(e) => { e.preventDefault(); verify(); }}
      class="space-y-4"
    >
      {#if showBackupCodeInput}
        <p class="text-sm text-muted-foreground">
          Enter one of your backup codes.
        </p>
        <Input
          type="text"
          autocomplete="off"
          bind:value={backupCode}
          required
          class="text-sm font-mono tracking-widest text-center"
          placeholder="XXXXX-XXXXX"
        />
      {:else}
        <p class="text-sm text-muted-foreground">
          Enter the 6-digit code from your authenticator app.
        </p>
        <Input
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          minlength={6}
          maxlength={6}
          bind:value={totpCode}
          required
          class="text-lg tracking-widest text-center"
          placeholder="000000"
        />
      {/if}

      {#if errorMessage}
        <p class="text-sm text-destructive">{errorMessage}</p>
      {/if}

      <div class="flex justify-between items-center">
        <Button variant="ghost" type="button" onclick={resetAndClose}>Cancel</Button>
        <Button type="submit" disabled={isVerifying}>
          {#if isVerifying}
            <Loader2 class="w-4 h-4 animate-spin" />
            Verifying...
          {:else}
            Verify
          {/if}
        </Button>
      </div>

      <div class="text-center">
        <button
          type="button"
          class="text-xs text-muted-foreground underline hover:text-foreground"
          onclick={() => {
            showBackupCodeInput = !showBackupCodeInput;
            errorMessage = undefined;
          }}
        >
          {showBackupCodeInput ? "Use authenticator app instead" : "Use a backup code instead"}
        </button>
      </div>
    </form>
  </div>
</Modal>
