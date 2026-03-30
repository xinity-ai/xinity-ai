<script lang="ts">
  type Versioning = {
    minorUpdate: boolean;
    majorUpdate: boolean;
    newestVersion: string;
    currentVersion: string;
  };

  export let versioning: Promise<Versioning>;

  let dismissed = false;

  function dismiss() {
    dismissed = true;
  }
</script>

{#await versioning then v}
  {#if !dismissed && (v.majorUpdate || v.minorUpdate)}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    {#if v.majorUpdate}
      <!-- svelte-ignore a11y_interactive_supports_focus -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-6"
        role="dialog"
        aria-modal="true"
        aria-label="Major update available"
        on:click={dismiss}
      >
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="relative w-full max-w-2xl rounded-xl border border-red-200 bg-card p-8 shadow-2xl"
          on:click|stopPropagation
        >
          <button
            class="absolute right-4 top-4 cursor-pointer rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            on:click={dismiss}
            type="button"
          >
            Dismiss
          </button>
          <div class="flex items-center gap-3">
            <div class="rounded-full bg-red-100 p-3 text-red-700">
              <svg
                viewBox="0 0 24 24"
                class="h-6 w-6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M12 9v4"></path>
                <path d="M12 17h.01"></path>
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              </svg>
            </div>
            <div>
              <p class="text-sm font-semibold uppercase tracking-wide text-red-700">
                Major update available
              </p>
              <h2 class="mt-1 text-2xl font-semibold text-slate-900">
                Please update to continue smoothly
              </h2>
            </div>
          </div>
          <p class="mt-4 text-slate-600">
            You are running v{v.currentVersion}. The latest version is v{v.newestVersion}.
          </p>
          <div class="mt-6 flex flex-wrap items-center gap-3">
            <button
              class="cursor-pointer rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
              type="button"
              on:click={dismiss}
            >
              Update later
            </button>
            <button
              class="cursor-pointer rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              type="button"
              on:click={dismiss}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    {:else}
      <div class="fixed right-4 top-4 z-40">
        <div
          class="flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 shadow-sm"
          aria-live="polite"
          title={`Current v${v.currentVersion} • Latest v${v.newestVersion}`}
        >
          <span class="h-2 w-2 rounded-full bg-amber-500"></span>
          <span>Update available</span>
          <span class="opacity-70">v{v.currentVersion}</span>
          <button
            class="ml-1 cursor-pointer rounded-full border border-amber-300 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            type="button"
            on:click={dismiss}
          >
            Dismiss
          </button>
        </div>
      </div>
    {/if}
  {/if}
{/await}
