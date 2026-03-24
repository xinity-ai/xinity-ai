<script lang="ts">
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Database from "@lucide/svelte/icons/database";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const state = $derived(data.migrationState);
</script>

<svelte:head>
  <title>Database Migration Required</title>
</svelte:head>

<div class="flex items-center justify-center min-h-screen px-4 bg-gray-100">
  <div class="w-full max-w-lg p-8 space-y-6 bg-white shadow-lg rounded-2xl">
    <div class="flex flex-col items-center gap-3 text-center">
      <div class="flex items-center justify-center w-14 h-14 rounded-full bg-amber-100">
        <TriangleAlert class="w-7 h-7 text-amber-600" />
      </div>
      <h1 class="text-xl font-bold text-gray-800">Database Migration Required</h1>
      <p class="text-gray-600">
        The dashboard detected that the database schema is not up to date.
        This usually indicates a misconfiguration or that migrations were not applied after an update.
      </p>
    </div>

    <div class="p-4 rounded-lg bg-gray-50 border border-gray-200 space-y-2">
      <div class="flex items-center gap-2 text-sm font-medium text-gray-700">
        <Database class="w-4 h-4" />
        <span>Migration Status</span>
      </div>
      {#if state.status === "pending"}
        <p class="text-sm text-gray-600">
          <span class="font-semibold text-amber-700">{state.applied}</span> of
          <span class="font-semibold">{state.expected}</span> migrations applied,
          <span class="font-semibold text-red-600">{state.expected - state.applied}</span> pending.
        </p>
      {:else if state.status === "no_table"}
        <p class="text-sm text-gray-600">
          The migrations table was not found. The database has not been initialized.
        </p>
      {:else if state.status === "error"}
        <p class="text-sm text-gray-600">
          Could not verify migration state:
        </p>
        <pre class="text-xs text-red-700 bg-red-50 p-2 rounded overflow-x-auto">{state.message}</pre>
      {/if}
    </div>

    <div class="space-y-3">
      <h2 class="text-sm font-semibold text-gray-700">How to fix this</h2>
      <ol class="text-sm text-gray-600 list-decimal list-inside space-y-1.5">
        <li>
          Apply pending migrations:
          <code class="px-1.5 py-0.5 rounded bg-gray-100 text-gray-800 text-xs">xinity up db</code>
          or manually with
          <code class="px-1.5 py-0.5 rounded bg-gray-100 text-gray-800 text-xs">cd packages/common-db && bun run migrate</code>
        </li>
        <li>Restart the dashboard after migrations complete.</li>
      </ol>
    </div>

    <p class="text-xs text-gray-400 text-center">
      The migration check runs once at startup. The dashboard must be restarted after applying migrations.
    </p>
  </div>
</div>
