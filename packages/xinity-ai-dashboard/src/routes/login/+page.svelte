<script lang="ts">
  import { goto } from "$app/navigation";
  import { signIn, signUp } from "$lib/auth";
  import KeyIcon from "$lib/components/icons/KeyIcon.svelte";
  import { createUrlSearchParamsStore } from "$lib/urlSearchParamsStore";
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
    if (!raw) return "An unknown error occurred.";
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
        // } else if (res?.requiresTwoFactor) {
        //   showingTOTP = true;
      }
      // Successful sign-in normally triggers redirect handled by auth lib
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
      } else {
        signUpSuccess = true;
        // Auto-close after short delay so user returns to original window
        setTimeout(() => window.close(), 3000);
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

<!-- Container -->
<div class="flex items-center justify-center min-h-screen px-4 bg-gray-100">
  <div class="w-full max-w-md p-6 space-y-6 bg-white shadow-lg rounded-2xl">
    {#if signUpSuccess}
      <!-- Success screen -->
      <div class="space-y-4 text-center">
        <h2 class="text-xl font-bold text-gray-800">Check your email</h2>
        <p class="text-gray-600">
          We've sent a verification link to <span class="font-medium"
            >{$params.email}</span
          >.<br />
          Please verify your address to continue.
        </p>
        <p class="text-sm text-gray-400">
          This window will close automatically.
        </p>
      </div>
    {:else}
      <!-- Tabs -->
      <div class="flex justify-between mb-4 border-b">
        <button
          id="tab-signin"
          class="w-1/2 py-2 font-semibold text-center border-b-2"
          class:text-gray-800={$params.tab !== "signup"}
          class:text-gray-500={$params.tab === "signup"}
          class:border-blue-600={$params.tab !== "signup"}
          on:click={() => ($params.tab = "")}
        >
          Sign In
        </button>
        <button
          id="tab-signup"
          class="w-1/2 py-2 font-semibold text-center border-b-2"
          class:text-gray-800={$params.tab === "signup"}
          class:text-gray-500={$params.tab !== "signup"}
          class:border-blue-600={$params.tab === "signup"}
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
          <p class="text-sm text-red-600">{errorSignIn}</p>
        {/if}
        <div>
          <label for="in-email" class="block text-sm font-medium text-gray-700"
            >Email</label
          >
          <input
            type="email"
            id="in-email"
            name="in-email"
            required
            bind:value={$params.email}
            class="block w-full mt-1 p-2 border-gray-300 rounded-lg shadow-sm outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label for="in-pass" class="block text-sm font-medium text-gray-700"
            >Password</label
          >
          <input
            type="password"
            id="in-pass"
            name="in-pass"
            required
            bind:value={password}
            class="block w-full mt-1 p-2 border-gray-300 rounded-lg shadow-sm outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <button
          type="submit"
          class="flex items-center justify-center w-full py-2 font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60"
          disabled={loadingSignIn}
        >
          {#if loadingSignIn}
            <svg
              class="w-5 h-5 mr-2 animate-spin"
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
            Signing in...
          {:else}
            Sign In
          {/if}
        </button>
        {#if data.ssoProviders?.length}
          <div class="relative my-2">
            <div class="absolute inset-0 flex items-center">
              <span class="w-full border-t border-gray-300"></span>
            </div>
            <div class="relative flex justify-center text-xs uppercase">
              <span class="bg-white px-2 text-gray-500">or continue with</span>
            </div>
          </div>
          {#each data.ssoProviders as provider}
            <a
              href="/api/auth/sso/{provider.providerId}"
              class="flex items-center justify-center w-full py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm font-medium text-gray-700"
            >
              Sign in with SSO ({provider.domain})
            </a>
          {/each}
        {/if}
        <button
          type="button"
          on:click={() =>
            signIn.passkey({
              fetchOptions: {
                onSuccess() {
                  goto("/");
                },
              },
            })}
          class="flex items-center justify-center w-full py-2 mt-2 border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          <span class="mr-2"><KeyIcon /></span> Sign in with Passkey
        </button>
      </form>

      <!-- Sign Up Form -->
      <form
        on:submit|preventDefault={signUserUp}
        id="form-signup"
        class="space-y-4"
        class:hidden={$params.tab !== "signup"}
      >
        {#if !data.signupEnabled}
          <div class="p-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg">
            Registration is invite-only. If you have received an invitation, sign up exactly with the invited email address.
          </div>
        {/if}
        {#if errorSignUp}
          <p class="text-sm text-red-600">{errorSignUp}</p>
        {/if}
        <div>
          <label for="name" class="block text-sm font-medium text-gray-700"
            >Full Name</label
          >
          <input
            type="text"
            id="name"
            name="name"
            required
            bind:value={$params.name}
            class="block w-full mt-1 p-2 border-gray-300 rounded-lg shadow-sm outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label for="up-email" class="block text-sm font-medium text-gray-700"
            >Email</label
          >
          <input
            type="email"
            name="up-email"
            id="up-email"
            required
            autocomplete="email webauthn"
            bind:value={$params.email}
            class="block w-full mt-1 p-2 border-gray-300 rounded-lg shadow-sm outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label for="up-pass" class="block text-sm font-medium text-gray-700"
            >Password</label
          >
          <input
            type="password"
            name="up-pass"
            id="up-pass"
            required
            autocomplete="current-password webauthn"
            bind:value={password}
            class="block w-full mt-1 p-2 border-gray-300 rounded-lg shadow-sm outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <button
          type="submit"
          class="flex items-center justify-center w-full py-2 font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-60"
          disabled={loadingSignUp}
        >
          {#if loadingSignUp}
            <svg
              class="w-5 h-5 mr-2 animate-spin"
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
            Creating account...
          {:else}
            Create Account
          {/if}
        </button>
      </form>
    {/if}
  </div>
</div>

<!-- 2FA TOTP Modal -->
<div
  id="totp-modal"
  class:fixed={showingTOTP}
  class:hidden={!showingTOTP}
  class="inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
>
  <div class="w-full max-w-sm p-6 bg-white shadow-xl rounded-2xl">
    <h2 class="mb-4 text-lg font-bold text-gray-800">
      Two-Factor Authentication
    </h2>
    <p class="mb-4 text-sm text-gray-600">
      Enter the 6-digit code from your authenticator app.
    </p>
    <input
      type="text"
      minlength="6"
      maxlength="6"
      bind:value={totpPass}
      class="w-full mb-4 text-lg tracking-widest text-center border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
      placeholder="------"
    />
    <div class="flex justify-between">
      <button
        class="text-sm text-gray-600 hover:text-gray-800"
        on:click={() => (showingTOTP = false)}>Cancel</button
      >
      <button
        class="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >Verify</button
      >
    </div>
  </div>
</div>
