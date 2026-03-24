<script lang="ts">
  import type { LicenseSummary } from "$lib/server/license";

  export let license: LicenseSummary;

  let dismissed = false;
</script>

{#if license.originMismatch}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-6" role="dialog" aria-modal="true" aria-label="License origin mismatch">
    <div class="relative w-full max-w-2xl rounded-2xl border border-red-200 bg-white p-8 shadow-2xl">
      <div class="flex items-center gap-3">
        <div class="rounded-full bg-red-100 p-3 text-red-700">
          <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 9v4"></path>
            <path d="M12 17h.01"></path>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          </svg>
        </div>
        <div>
          <p class="text-sm font-semibold uppercase tracking-wide text-red-700">
            License configuration error
          </p>
          <h2 class="mt-1 text-2xl font-semibold text-slate-900">
            Origin mismatch
          </h2>
        </div>
      </div>
      <p class="mt-4 text-slate-600">
        The dashboard's <code class="rounded bg-slate-100 px-1.5 py-0.5 text-sm font-mono">ORIGIN</code> does not match the origin in your license key.
        Please update your <code class="rounded bg-slate-100 px-1.5 py-0.5 text-sm font-mono">ORIGIN</code> environment variable to match the URL specified in your license, or contact Xinity to update your license key.
      </p>
      <p class="mt-3 text-sm text-slate-500">
        The dashboard is idling until this is resolved. Check your server logs for details.
      </p>
    </div>
  </div>
{:else if !dismissed && license.expired && license.inGracePeriod}
  <div class="fixed right-4 top-4 z-40">
    <div
      class="flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 shadow-sm"
      aria-live="polite"
    >
      <span class="h-2 w-2 rounded-full bg-amber-500"></span>
      <span>License expired — enterprise features will be disabled soon</span>
      <button
        class="ml-1 cursor-pointer rounded-full border border-amber-300 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
        type="button"
        on:click={() => { dismissed = true; }}
      >
        Dismiss
      </button>
    </div>
  </div>
{/if}
