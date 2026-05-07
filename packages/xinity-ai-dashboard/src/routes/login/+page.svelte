<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { signIn, signUp } from "$lib/auth";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Card from "$lib/components/ui/card";
  import Modal from "$lib/components/Modal.svelte";
  import KeyIcon from "$lib/components/icons/KeyIcon.svelte";
  import { createUrlSearchParamsStore } from "$lib/urlSearchParamsStore";
  import { Loader2 } from "@lucide/svelte";
  import type { PageData } from "./$types";

  export let data: PageData;

  // URL-backed state: tab, email, and name survive page refreshes.
  // The invitation email link sends ?email=...&tab=signup, which the store picks up directly.
  const params = createUrlSearchParamsStore();

  let showingTOTP = false;

  // Sensitive inputs stay local, never in the URL
  let password = "";
  let totpPass = "";

  // Async state & feedback
  let loadingSignIn = false;
  let loadingSignUp = false;
  let errorSignIn: string | undefined;
  let errorSignUp: string | undefined;
  let signUpSuccess = false;

  /** Turn raw Better Auth / Zod validation errors into user-friendly text. */
  function friendlyError(raw: string | undefined): string {
    const originMisconfigured = `This dashboard is configured for a different URL than the one you used to reach it, so authentication cannot complete. Contact your administrator for the correct URL and how to access it.`;
    if (!raw) return originMisconfigured;
    if (/invalid origin|missing or null origin|cross-site navigation login blocked/i.test(raw)) {
      return originMisconfigured;
    }
    const match = raw.match(/^\[body\.(\w+)\]\s*(.+)/);
    if (!match) return raw;
    const [, field, detail] = match;
    const labels: Record<string, string> = { name: "name", email: "email address", password: "password" };
    const label = labels[field] ?? field;
    if (detail.includes("received undefined") || detail.includes("required")) {
      return `Please enter your ${label}.`;
    }
    return `Invalid ${label}: ${detail}`;
  }

  async function signUserIn() {
    errorSignIn = undefined;
    loadingSignIn = true;
    try {
      const res = await signIn.email({
        email: $params.email,
        password,
        callbackURL: data.callbackUrl,
        rememberMe: true,
      });

      if (res?.error) {
        errorSignIn = friendlyError(res.error.message);
        console.log(res.error)
      }
    } catch (e) {
      errorSignIn = (e as Error).message ?? "Unexpected error";
    } finally {
      loadingSignIn = false;
    }
  }

  async function signUserUp() {
    errorSignUp = undefined;
    loadingSignUp = true;
    try {
      const res = await signUp.email({
        email: $params.email,
        password,
        name: $params.name,
        callbackURL: data.callbackUrl,
      });

      if (res?.error) {
        errorSignUp = friendlyError(res.error.message);
      } else if (data.emailVerificationRequired) {
        signUpSuccess = true;
        setTimeout(() => window.close(), 3000);
      } else {
        await goto(data.callbackUrl);
      }
    } catch (e) {
      errorSignUp = (e as Error).message ?? "Unexpected error";
    } finally {
      loadingSignUp = false;
    }
  }
</script>

<svelte:head>
  <title>Login</title>
</svelte:head>

<div class="flex items-center justify-center min-h-screen px-4 bg-background">
  <Card.Root class="w-full max-w-md">
    <Card.Header class="items-center">
      <img src="/xinity-logo.png" alt="Xinity" class="h-10 w-auto" />
    </Card.Header>
    <Card.Content class="space-y-6">
      {#if data.hostMismatch}
        <div role="alert" class="space-y-2 p-4 text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-lg">
          <p class="font-semibold">Wrong dashboard URL</p>
          <p>
            This dashboard is configured for
            <span class="font-mono break-all">{data.configuredOrigin}</span>,
            but you reached it via
            <span class="font-mono break-all">{$page.url.origin}</span>.
            Authentication will not work here.
          </p>
          <p>
            Contact your administrator for the correct URL and how to access it.
          </p>
        </div>
      {:else if signUpSuccess}
        <div class="space-y-4 text-center">
          <h2 class="text-xl font-bold">Check your email</h2>
          <p class="text-muted-foreground">
            We've sent a verification link to <span class="font-medium text-foreground">{$params.email}</span>.<br />
            Please verify your address to continue.
          </p>
          <p class="text-sm text-muted-foreground">
            This window will close automatically.
          </p>
        </div>
      {:else}
        <!-- Tabs -->
        <div class="flex border-b border-border">
          <button
            id="tab-signin"
            class="w-1/2 py-2 font-semibold text-center border-b-2 transition-colors {$params.tab !== 'signup' ? 'text-foreground border-primary' : 'text-muted-foreground border-transparent hover:text-foreground'}"
            on:click={() => ($params.tab = "")}
          >
            Sign In
          </button>
          <button
            id="tab-signup"
            class="w-1/2 py-2 font-semibold text-center border-b-2 transition-colors {$params.tab === 'signup' ? 'text-foreground border-primary' : 'text-muted-foreground border-transparent hover:text-foreground'}"
            on:click={() => ($params.tab = "signup")}
          >
            Sign Up
          </button>
        </div>

        <!-- Sign In Form -->
        <form
          on:submit|preventDefault={signUserIn}
          id="form-signin"
          class="space-y-4"
          class:hidden={$params.tab === "signup"}
        >
          {#if errorSignIn}
            <p role="alert" class="text-sm text-destructive">{errorSignIn}</p>
          {/if}
          <div class="space-y-2">
            <Label for="in-email">Email</Label>
            <Input
              type="email"
              id="in-email"
              name="in-email"
              required
              bind:value={$params.email}
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
          <Button type="submit" class="w-full" disabled={loadingSignIn}>
            {#if loadingSignIn}
              <Loader2 class="w-4 h-4 animate-spin" />
              Signing in...
            {:else}
              Sign In
            {/if}
          </Button>
          {#if data.ssoProviders?.length}
            <div class="relative my-2">
              <div class="absolute inset-0 flex items-center">
                <span class="w-full border-t border-border"></span>
              </div>
              <div class="relative flex justify-center text-xs uppercase">
                <span class="bg-card px-2 text-muted-foreground">or continue with</span>
              </div>
            </div>
            {#each data.ssoProviders as provider}
              <Button variant="outline" href="/api/auth/sso/{provider.providerId}" class="w-full">
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

        <!-- Sign Up Form -->
        <form
          on:submit|preventDefault={signUserUp}
          id="form-signup"
          class="space-y-4"
          class:hidden={$params.tab !== "signup"}
        >
          {#if !data.signupEnabled}
            <div class="p-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg dark:text-amber-200 dark:bg-amber-900/20 dark:border-amber-800">
              Registration is invite-only. If you have received an invitation, sign up exactly with the invited email address.
            </div>
          {/if}
          {#if errorSignUp}
            <p role="alert" class="text-sm text-destructive">{errorSignUp}</p>
          {/if}
          <div class="space-y-2">
            <Label for="name">Full Name</Label>
            <Input
              type="text"
              id="name"
              name="name"
              required
              bind:value={$params.name}
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
              bind:value={$params.email}
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
          <Button type="submit" class="w-full" disabled={loadingSignUp}>
            {#if loadingSignUp}
              <Loader2 class="w-4 h-4 animate-spin" />
              Creating account...
            {:else}
              Create Account
            {/if}
          </Button>
        </form>
      {/if}
    </Card.Content>
  </Card.Root>
</div>

<!-- 2FA TOTP Modal -->
<Modal bind:open={showingTOTP} onClose={() => { showingTOTP = false; }}>
  <div class="bg-card rounded-xl border shadow-2xl max-w-sm w-full p-6">
    <h2 class="mb-4 text-lg font-bold">Two-Factor Authentication</h2>
    <p class="mb-4 text-sm text-muted-foreground">
      Enter the 6-digit code from your authenticator app.
    </p>
    <Input
      type="text"
      minlength={6}
      maxlength={6}
      bind:value={totpPass}
      class="text-lg tracking-widest text-center mb-4"
      placeholder="------"
    />
    <div class="flex justify-between">
      <Button variant="ghost" onclick={() => (showingTOTP = false)}>Cancel</Button>
      <Button>Verify</Button>
    </div>
  </div>
</Modal>
