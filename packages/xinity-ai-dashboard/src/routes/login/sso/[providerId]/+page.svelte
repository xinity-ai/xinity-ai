<script lang="ts">
  import { page } from "$app/state";
  import { signIn } from "$lib/auth";

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
      // Initiates SSO sign in, with the selected provider.
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

<div class="flex min-h-screen items-center justify-center bg-gray-100 px-4 py-12">
  <main class="w-full max-w-md">
    <div class="space-y-6 rounded-2xl bg-white p-6 shadow-lg">
      <div class="space-y-2">
        <p class="text-xs font-semibold uppercase tracking-widest text-gray-500">
          Secure sign in
        </p>
        <h1 class="text-2xl font-bold text-gray-800">
          Continue with {providerLabel}
        </h1>
        <p class="text-sm text-gray-600">
          We'll send you to {providerLabel} to verify your identity and then
          bring you right back to Xinity.
        </p>
      </div>

      <div class="space-y-4">
        <button
          type="button"
          onclick={handleSignIn}
          disabled={!hasProvider || isLoading}
          class="flex w-full items-center justify-center gap-2 rounded-lg bg-xinity-purple py-2 font-semibold text-white hover:bg-xinity-purple/80 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          {#if isLoading}
            <svg
              class="h-5 w-5 animate-spin"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
              ></circle>
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 100 16 8 8 0 008-8h-4l3 3 3-3h-4a8 8 0 01-8 8 8 8 0 01-8-8z"
              ></path>
            </svg>
            Connecting...
          {:else}
            Continue with {providerLabel}
          {/if}
        </button>

        {#if errorMessage}
          <p class="text-sm text-red-600">{errorMessage}</p>
        {/if}

        {#if !hasProvider}
          <p class="text-sm text-red-600">
            Missing provider ID. Return to the login page and choose a provider
            to continue.
          </p>
        {/if}
      </div>

      <div class="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <h2 class="text-xs font-semibold uppercase tracking-widest text-gray-500">
          What happens next
        </h2>
        <ul class="mt-3 space-y-3 text-sm text-gray-600">
          <li class="flex items-start gap-2">
            <span class="mt-1 inline-block h-2 w-2 rounded-full bg-xinity-purple"></span>
            We'll request only the basic profile information you share with
            {providerLabel}.
          </li>
          <li class="flex items-start gap-2">
            <span class="mt-1 inline-block h-2 w-2 rounded-full bg-xinity-purple"></span>
            You'll be redirected back here once authentication completes.
          </li>
        </ul>
      </div>

      <div class="text-center text-xs text-gray-500">
        <p>By continuing you agree to Xinity's security policies.</p>
        <a class="text-xinity-magenta hover:text-xinity-pink" href="/login">
          Choose a different sign-in method
        </a>
      </div>
    </div>
  </main>
</div>
