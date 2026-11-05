<script lang="ts">
  import { goto } from "$app/navigation";
  import { SvelteSet } from "svelte/reactivity";
  import { signIn } from "$lib/auth";
  import { friendlyError, friendlySsoError } from "./friendly-error";
  import { ssoProviderLabel } from "./sso-provider-label";

  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import KeyIcon from "$lib/components/icons/KeyIcon.svelte";
  import { LoaderCircle } from "@lucide/svelte";

  let {
    email = $bindable(),
    callbackUrl,
    ssoProviders = [],
    internalSigninEnabled,
    onTwoFactorRedirect,
  }: {
    email: string | undefined;
    callbackUrl: string;
    ssoProviders?: { providerId: string; iconUrl?: string }[];
    internalSigninEnabled: boolean;
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

  let ssoPendingProviderId = $state<string | undefined>();
  const failedIconProviderIds = new SvelteSet<string>();

  async function startSso(providerId: string) {
    error = undefined;
    ssoPendingProviderId = providerId;
    try {
      const res = await signIn.sso({
        providerId,
        callbackURL: callbackUrl,
        errorCallbackURL: `/login/sso/${providerId}/?callbackUrl=${encodeURIComponent(callbackUrl)}`,
      });
      if (res?.error) {
        error = friendlySsoError(res.error.message) ?? res.error.message;
        ssoPendingProviderId = undefined;
      }
    } catch (e) {
      error = (e as Error).message ?? "Unexpected error";
      ssoPendingProviderId = undefined;
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
  {#if internalSigninEnabled}
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
        <LoaderCircle class="w-4 h-4 animate-spin" />
        Signing in...
      {:else}
        Sign In
      {/if}
    </Button>
  {:else if !ssoProviders.length}
    <p role="alert" class="text-sm text-muted-foreground text-center">
      No sign-in method is available. Contact your administrator.
    </p>
  {/if}
  {#if ssoProviders.length}
    {#if internalSigninEnabled}
      <div class="relative my-2">
        <div class="absolute inset-0 flex items-center">
          <span class="w-full border-t border-border"></span>
        </div>
        <div class="relative flex justify-center text-xs uppercase">
          <span class="bg-card px-2 text-muted-foreground">or continue with</span>
        </div>
      </div>
    {/if}
    {#each ssoProviders as provider}
      <Button
        variant="outline"
        type="button"
        class="w-full"
        disabled={ssoPendingProviderId !== undefined}
        onclick={() => startSso(provider.providerId)}
      >
        {#if ssoPendingProviderId === provider.providerId}
          <LoaderCircle class="w-4 h-4 animate-spin" />
          Redirecting...
        {:else}
          {#if provider.iconUrl && !failedIconProviderIds.has(provider.providerId)}
            <img
              src={provider.iconUrl}
              alt=""
              class="w-4 h-4"
              referrerpolicy="no-referrer"
              onerror={() => failedIconProviderIds.add(provider.providerId)}
            />
          {/if}
          Continue with {ssoProviderLabel(provider.providerId)}
        {/if}
      </Button>
    {/each}
  {/if}
  {#if internalSigninEnabled}
    <Button
      variant="outline"
      class="w-full"
      type="button"
      onclick={() =>
        signIn.passkey({
          fetchOptions: {
            onSuccess() {
              goto(callbackUrl);
            },
          },
        })}
    >
      <KeyIcon /> Sign in with Passkey
    </Button>
  {/if}
</form>
