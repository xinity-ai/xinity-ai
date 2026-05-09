<script lang="ts">
  import type { LicenseSummary } from "$lib/server/license";

  let { license, totalVramGb = 0 }: { license: LicenseSummary; totalVramGb?: number } = $props();

  let dismissed = $state(false);
  let vramDismissed = $state(false);
</script>

{#if license.originMismatch || license.instanceMismatch}
  <div
    class="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 mx-4 mt-4"
    role="status"
    aria-live="polite"
  >
    <p class="font-semibold">
      License key doesn't match this {license.originMismatch ? "origin" : "instance"} — running in free tier.
    </p>
    <p class="mt-1 text-red-800">
      {#if license.originMismatch}
        The dashboard's <code class="rounded bg-red-100 px-1 py-0.5 font-mono text-xs">ORIGIN</code> does not match any origin in your license key.
        Update <code class="rounded bg-red-100 px-1 py-0.5 font-mono text-xs">ORIGIN</code> to match the licensed URL, or contact Xinity to update your license key.
      {:else}
        Your license key was issued for a different deployment instance. Contact Xinity to reissue the key for this deployment.
      {/if}
      Check your server logs for details.
    </p>
  </div>
{/if}

{#if !dismissed && license.expired && license.inGracePeriod}
  <div class="fixed right-4 top-4 z-40">
    <div
      class="flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 shadow-sm"
      aria-live="polite"
    >
      <span class="h-2 w-2 rounded-full bg-amber-500"></span>
      <span>License expired: enterprise features will be disabled soon</span>
      <button
        class="ml-1 cursor-pointer rounded-full border border-amber-300 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
        type="button"
        onclick={() => { dismissed = true; }}
      >
        Dismiss
      </button>
    </div>
  </div>
{/if}

{#if !vramDismissed && totalVramGb > license.maxVramGb}
  <div class="fixed right-4 top-4 z-40" style:top={!dismissed && license.expired && license.inGracePeriod ? "3.5rem" : "1rem"}>
    <div
      class="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 shadow-sm max-w-md"
      aria-live="polite"
    >
      <span class="h-2 w-2 shrink-0 rounded-full bg-amber-500"></span>
      <span>
        {totalVramGb} GB of VRAM detected across your instances but your license allows {license.maxVramGb} GB. Some instances will be excluded from deployments.
        <a href="https://xinity.ai/xinity-pricing" target="_blank" rel="noopener noreferrer" class="underline hover:text-amber-900">Upgrade</a> to use all capacity.
      </span>
      <button
        class="ml-1 shrink-0 cursor-pointer rounded-full border border-amber-300 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
        type="button"
        onclick={() => { vramDismissed = true; }}
      >
        Dismiss
      </button>
    </div>
  </div>
{/if}
