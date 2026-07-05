<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { twoFactor } from "$lib/auth";
  import { copyToClipboard } from "$lib/copy";
  import { toastState } from "$lib/state/toast.svelte";
  import { renderSVG } from "uqr";

  import BackupCodesDisplay from "./BackupCodesDisplay.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Loader2, Copy } from "@lucide/svelte";

  let { onComplete, onCancel }: {
    onComplete: () => void;
    onCancel: () => void;
  } = $props();

  type Step = "password" | "qr" | "verify";
  let step = $state<Step>("password");
  let password = $state("");
  let totpCode = $state("");
  let errorMessage = $state("");
  let isSubmitting = $state(false);
  let totpURI = $state("");
  let backupCodes = $state<string[]>([]);

  let qrSvg = $derived(totpURI ? renderSVG(totpURI, { border: 2 }) : "");

  function extractSecret(uri: string): string {
    try {
      return new URL(uri).searchParams.get("secret") ?? "";
    } catch {
      return "";
    }
  }

  async function handleEnable() {
    errorMessage = "";
    isSubmitting = true;

    const res = await twoFactor.enable({ password });
    isSubmitting = false;

    if (res.error) {
      errorMessage = res.error.message ?? "Failed to enable two-factor authentication";
      return;
    }

    totpURI = res.data?.totpURI ?? "";
    backupCodes = res.data?.backupCodes ?? [];
    password = "";
    step = "qr";
  }

  async function handleVerify() {
    errorMessage = "";
    isSubmitting = true;

    const res = await twoFactor.verifyTotp({ code: totpCode });
    isSubmitting = false;

    if (res.error) {
      errorMessage = res.error.message ?? "Invalid code";
      return;
    }

    toastState.add("Two-factor authentication enabled", "success");
    onComplete();
    invalidateAll();
  }
</script>

<div class="space-y-4 max-w-md">
  {#if step === "password"}
    <form
      onsubmit={(e) => { e.preventDefault(); handleEnable(); }}
      class="space-y-4"
    >
      <p class="text-sm text-muted-foreground">
        Enter your password to set up two-factor authentication.
      </p>
      <div class="space-y-2">
        <Label for="2fa-enable-password">Password</Label>
        <Input
          id="2fa-enable-password"
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
        <Button variant="outline" type="button" onclick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={isSubmitting}>
          {#if isSubmitting}
            <Loader2 class="w-4 h-4 animate-spin" />
            Setting up...
          {:else}
            Continue
          {/if}
        </Button>
      </div>
    </form>

  {:else if step === "qr"}
    <div class="space-y-6">
      <div class="space-y-2">
        <h3 class="text-base font-semibold">Scan QR Code</h3>
        <p class="text-sm text-muted-foreground">
          Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.).
        </p>
        <div class="flex justify-center p-4 bg-white rounded-lg w-fit mx-auto [&>svg]:w-48 [&>svg]:h-48">
          {@html qrSvg}
        </div>
      </div>

      <div class="space-y-2">
        <p class="text-sm text-muted-foreground">Or enter this key manually:</p>
        <div class="flex items-center gap-2">
          <code class="flex-1 text-sm font-mono bg-muted px-3 py-2 rounded-md break-all select-all">
            {extractSecret(totpURI)}
          </code>
          <Button variant="outline" size="sm" onclick={() => copyToClipboard(extractSecret(totpURI))}>
            <Copy class="w-4 h-4" />
          </Button>
        </div>
      </div>

      <BackupCodesDisplay
        codes={backupCodes}
        description="Save these backup codes in a safe place. Each code can only be used once."
      />

      <Button onclick={() => { errorMessage = ""; step = "verify"; }}>
        Continue to Verification
      </Button>
    </div>

  {:else if step === "verify"}
    <form
      onsubmit={(e) => { e.preventDefault(); handleVerify(); }}
      class="space-y-4"
    >
      <p class="text-sm text-muted-foreground">
        Enter the 6-digit code from your authenticator app to complete setup.
      </p>
      <div class="space-y-2">
        <Label for="2fa-verify-code">Verification Code</Label>
        <Input
          id="2fa-verify-code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          minlength={6}
          maxlength={6}
          required
          bind:value={totpCode}
          placeholder="000000"
          class="text-lg tracking-widest text-center"
        />
      </div>

      {#if errorMessage}
        <p class="text-sm text-destructive">{errorMessage}</p>
      {/if}

      <div class="flex gap-2">
        <Button variant="outline" type="button" onclick={() => { errorMessage = ""; step = "qr"; }}>
          Back
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {#if isSubmitting}
            <Loader2 class="w-4 h-4 animate-spin" />
            Verifying...
          {:else}
            Verify and Enable
          {/if}
        </Button>
      </div>
    </form>
  {/if}
</div>
