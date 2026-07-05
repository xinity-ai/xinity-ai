<script lang="ts">
  import { page } from "$app/state";
  import * as Card from "$lib/components/ui/card";
  import { createUrlSearchParamsStore } from "$lib/urlSearchParamsStore";
  import type { PageData } from "./$types";

  import SignInForm from "./SignInForm.svelte";
  import SignUpForm from "./SignUpForm.svelte";
  import TotpVerificationModal from "./TotpVerificationModal.svelte";

  let { data }: { data: PageData } = $props();

  const params = createUrlSearchParamsStore();

  let showingTOTP = $state(false);
  let signUpSuccess = $state(false);
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
            <span class="font-mono break-all">{page.url.origin}</span>.
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
        <div class="flex border-b border-border">
          <button
            id="tab-signin"
            class="w-1/2 py-2 font-semibold text-center border-b-2 transition-colors {$params.tab !== 'signup' ? 'text-foreground border-primary' : 'text-muted-foreground border-transparent hover:text-foreground'}"
            onclick={() => ($params.tab = "")}
          >
            Sign In
          </button>
          <button
            id="tab-signup"
            class="w-1/2 py-2 font-semibold text-center border-b-2 transition-colors {$params.tab === 'signup' ? 'text-foreground border-primary' : 'text-muted-foreground border-transparent hover:text-foreground'}"
            onclick={() => ($params.tab = "signup")}
          >
            Sign Up
          </button>
        </div>

        <div class:hidden={$params.tab === "signup"}>
          <SignInForm
            bind:email={$params.email}
            callbackUrl={data.callbackUrl}
            ssoProviders={data.ssoProviders}
            onTwoFactorRedirect={() => (showingTOTP = true)}
          />
        </div>

        <div class:hidden={$params.tab !== "signup"}>
          <SignUpForm
            bind:email={$params.email}
            bind:name={$params.name}
            callbackUrl={data.callbackUrl}
            signupEnabled={data.signupEnabled}
            emailVerificationRequired={data.emailVerificationRequired}
            onVerificationSent={() => {
              signUpSuccess = true;
              setTimeout(() => window.close(), 3000);
            }}
          />
        </div>
      {/if}
    </Card.Content>
  </Card.Root>
</div>

<TotpVerificationModal bind:open={showingTOTP} callbackUrl={data.callbackUrl} />
