<script lang="ts">
  import { page } from "$app/state";
  import { signIn } from "$lib/auth";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Loader2 } from "@lucide/svelte";

  const providerId = $derived(page.params.providerId ?? "");
  const providerLabel = $derived(formatProviderId(providerId));
  const hasProvider = $derived(providerId.length > 0);
  const callbackURL = "/";

  let errorMessage = $state("");
  let isLoading = $state(false);

  function formatProviderId(id: string) {
    if (!id) return "your provider";
    return id
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  async function handleSignIn() {
    if (!hasProvider || isLoading) return;

    errorMessage = "";
    isLoading = true;

    try {
      const { error } = await signIn.sso({
        providerId,
        callbackURL,
      });

      if (error?.message) {
        errorMessage = error.message;
      }
    } catch (err) {
      errorMessage =
        err instanceof Error
          ? err.message
          : "Something went wrong while starting SSO. Please try again.";
    } finally {
      isLoading = false;
    }
  }
</script>

<svelte:head>
  <title>Continue with {providerLabel}</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-background px-4 py-12">
  <Card.Root class="w-full max-w-md">
    <Card.Header>
      <p class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Secure sign in
      </p>
      <Card.Title class="text-2xl">Continue with {providerLabel}</Card.Title>
      <Card.Description>
        We'll send you to {providerLabel} to verify your identity and then
        bring you right back to Xinity.
      </Card.Description>
    </Card.Header>
    <Card.Content class="space-y-6">
      <div class="space-y-4">
        <Button
          class="w-full"
          onclick={handleSignIn}
          disabled={!hasProvider || isLoading}
        >
          {#if isLoading}
            <Loader2 class="w-4 h-4 animate-spin" />
            Connecting...
          {:else}
            Continue with {providerLabel}
          {/if}
        </Button>

        {#if errorMessage}
          <p class="text-sm text-destructive">{errorMessage}</p>
        {/if}

        {#if !hasProvider}
          <p class="text-sm text-destructive">
            Missing provider ID. Return to the login page and choose a provider
            to continue.
          </p>
        {/if}
      </div>

      <div class="rounded-xl border bg-muted/50 p-4">
        <h2 class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          What happens next
        </h2>
        <ul class="mt-3 space-y-3 text-sm text-muted-foreground">
          <li class="flex items-start gap-2">
            <span class="mt-1 inline-block h-2 w-2 rounded-full bg-primary"></span>
            We'll request only the basic profile information you share with
            {providerLabel}.
          </li>
          <li class="flex items-start gap-2">
            <span class="mt-1 inline-block h-2 w-2 rounded-full bg-primary"></span>
            You'll be redirected back here once authentication completes.
          </li>
        </ul>
      </div>

      <div class="text-center text-xs text-muted-foreground">
        <p>By continuing you agree to Xinity's security policies.</p>
        <a class="text-primary hover:text-primary/80 transition-colors" href="/login">
          Choose a different sign-in method
        </a>
      </div>
    </Card.Content>
  </Card.Root>
</div>
