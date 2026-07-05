<script lang="ts">
  import { goto } from "$app/navigation";
  import { signUp } from "$lib/auth";
  import { friendlyError } from "./friendly-error";

  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Loader2 } from "@lucide/svelte";

  let {
    email = $bindable(),
    name = $bindable(),
    callbackUrl,
    signupEnabled,
    emailVerificationRequired,
    onVerificationSent,
  }: {
    email: string | undefined;
    name: string | undefined;
    callbackUrl: string;
    signupEnabled: boolean;
    emailVerificationRequired: boolean;
    onVerificationSent: () => void;
  } = $props();

  let password = $state("");
  let isLoading = $state(false);
  let error = $state<string | undefined>();

  async function submit() {
    error = undefined;
    isLoading = true;
    try {
      const res = await signUp.email({
        email: email ?? "",
        password,
        name: name ?? "",
        callbackURL: callbackUrl,
      });

      if (res?.error) {
        error = friendlyError(res.error.message);
      } else if (emailVerificationRequired) {
        onVerificationSent();
      } else {
        await goto(callbackUrl);
      }
    } catch (e) {
      error = (e as Error).message ?? "Unexpected error";
    } finally {
      isLoading = false;
    }
  }
</script>

<form
  onsubmit={(e) => { e.preventDefault(); submit(); }}
  class="space-y-4"
>
  {#if !signupEnabled}
    <div class="p-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg dark:text-amber-200 dark:bg-amber-900/20 dark:border-amber-800">
      Registration is invite-only. If you have received an invitation, sign up exactly with the invited email address.
    </div>
  {/if}
  {#if error}
    <p role="alert" class="text-sm text-destructive">{error}</p>
  {/if}
  <div class="space-y-2">
    <Label for="name">Full Name</Label>
    <Input
      type="text"
      id="name"
      name="name"
      required
      bind:value={name}
    />
  </div>
  <div class="space-y-2">
    <Label for="up-email">Email</Label>
    <Input
      type="email"
      name="up-email"
      id="up-email"
      required
      autocomplete="email webauthn"
      bind:value={email}
    />
  </div>
  <div class="space-y-2">
    <Label for="up-pass">Password</Label>
    <Input
      type="password"
      name="up-pass"
      id="up-pass"
      required
      autocomplete="current-password webauthn"
      bind:value={password}
    />
  </div>
  <Button type="submit" class="w-full" disabled={isLoading}>
    {#if isLoading}
      <Loader2 class="w-4 h-4 animate-spin" />
      Creating account...
    {:else}
      Create Account
    {/if}
  </Button>
</form>
