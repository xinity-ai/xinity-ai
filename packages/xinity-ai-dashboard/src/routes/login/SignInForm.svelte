<script lang="ts">
  import { goto } from "$app/navigation";
  import { signIn } from "$lib/auth";
  import { friendlyError } from "./friendly-error";

  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import KeyIcon from "$lib/components/icons/KeyIcon.svelte";
  import { Loader2 } from "@lucide/svelte";

  let {
    email = $bindable(),
    callbackUrl,
    ssoProviders = [],
    onTwoFactorRedirect,
  }: {
    email: string | undefined;
    callbackUrl: string;
    ssoProviders?: { providerId: string; domain: string }[];
    onTwoFactorRedirect: () => void;
  } = $props();

  let password = $state("");
  let isLoading = $state(false);
  let error = $state<string | undefined>();

  async function submit() {
    error = undefined;
    isLoading = true;
    try {
      const res = await signIn.email({
        email: email ?? "",
        password,
        callbackURL: callbackUrl,
        rememberMe: true,
      });

      if ((res?.data as Record<string, unknown>)?.twoFactorRedirect) {
        onTwoFactorRedirect();
        return;
      }

      if (res?.error) {
        error = friendlyError(res.error.message);
      }
    } catch (e) {
      error = (e as Error).message ?? "Unexpected error";
    } finally {
      isLoading = false;
    }
  }
</script>

<form
  id="form-signin"
  onsubmit={(e) => { e.preventDefault(); submit(); }}
  class="space-y-4"
>
  {#if error}
    <p role="alert" class="text-sm text-destructive">{error}</p>
  {/if}
  <div class="space-y-2">
    <Label for="in-email">Email</Label>
    <Input
      type="email"
      id="in-email"
      name="in-email"
      required
      bind:value={email}
    />
  </div>
  <div class="space-y-2">
    <Label for="in-pass">Password</Label>
    <Input
      type="password"
      id="in-pass"
      name="in-pass"
      required
      bind:value={password}
    />
  </div>
  <Button type="submit" class="w-full" disabled={isLoading}>
    {#if isLoading}
      <Loader2 class="w-4 h-4 animate-spin" />
      Signing in...
    {:else}
      Sign In
    {/if}
  </Button>
  {#if ssoProviders?.length}
    <div class="relative my-2">
      <div class="absolute inset-0 flex items-center">
        <span class="w-full border-t border-border"></span>
      </div>
      <div class="relative flex justify-center text-xs uppercase">
        <span class="bg-card px-2 text-muted-foreground">or continue with</span>
      </div>
    </div>
    {#each ssoProviders as provider}
      <Button variant="outline" href="/login/sso/{provider.providerId}" class="w-full">
        Sign in with SSO ({provider.domain})
      </Button>
    {/each}
  {/if}
  <Button
    variant="outline"
    class="w-full"
    type="button"
    onclick={() =>
      signIn.passkey({
        fetchOptions: {
          onSuccess() {
            goto("/");
          },
        },
      })}
  >
    <KeyIcon /> Sign in with Passkey
  </Button>
</form>
