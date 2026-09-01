<script lang="ts">
  import { onMount } from "svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Database, TriangleAlert } from "@lucide/svelte";
  import { toastState } from "$lib/state/toast.svelte";

  const CHUNK_SIZE = 250;

  let remaining = $state<number | null>(null);
  let converted = $state(0);
  let failed = $state(0);
  let running = $state(false);
  let stopRequested = $state(false);

  const done = $derived(remaining === 0);

  async function refresh() {
    const result = await orpc.instanceAdmin.legacyCallStatus({});
    if (result.data) {
      remaining = result.data.remaining;
    }
  }

  /** Stops when a chunk converts nothing, so rows that always fail cannot spin the loop forever. */
  async function run() {
    running = true;
    stopRequested = false;
    converted = 0;
    failed = 0;

    while (!stopRequested) {
      const result = await orpc.instanceAdmin.convertLegacyCalls({ chunkSize: CHUNK_SIZE });
      if (!result.data) {
        toastState.add("The conversion failed. Nothing was lost, see the server log.", "error");
        break;
      }

      converted += result.data.converted;
      failed += result.data.failed;
      remaining = result.data.remaining;

      if (result.data.remaining === 0) {
        toastState.add(`Converted ${converted} calls. Nothing is left in the legacy table.`, "success");
        break;
      }
      if (result.data.converted === 0) {
        toastState.add(`${result.data.remaining} calls could not be converted. See the server log.`, "error");
        break;
      }
    }

    running = false;
  }

  onMount(() => {
    void refresh();
  });
</script>

<svelte:head><title>Maintenance | Instance Settings</title></svelte:head>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold">Maintenance</h1>
    <p class="text-sm text-muted-foreground">One-off data operations for this instance.</p>
  </div>

  {#if remaining !== null && !done}
    <Card.Root>
      <Card.Header>
        <Card.Title class="flex items-center gap-2">
          <Database class="size-4" />
          Convert legacy call log
        </Card.Title>
        <Card.Description>
          {remaining.toLocaleString()} calls are still stored in the old format. Converting moves each
          one, with its messages and labels, into the current tables and removes the original. New
          calls are already written in the current format, so this only ever has to run once.
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        {#if running || converted > 0 || failed > 0}
          <p class="text-sm tabular-nums">
            Converted {converted.toLocaleString()}, {remaining.toLocaleString()} remaining{#if failed > 0}, <span class="text-destructive">{failed.toLocaleString()} failed</span>{/if}
          </p>
        {/if}

        {#if failed > 0}
          <p class="flex items-start gap-2 text-sm text-muted-foreground">
            <TriangleAlert class="mt-0.5 size-4 shrink-0" />
            Calls that fail are left untouched in the old format and logged on the server. Everything
            else converted normally.
          </p>
        {/if}

        <div class="flex gap-2">
          {#if running}
            <Button variant="outline" onclick={() => (stopRequested = true)}>Stop</Button>
          {:else}
            <Button onclick={run}>Convert {remaining.toLocaleString()} calls</Button>
          {/if}
        </div>
      </Card.Content>
    </Card.Root>
  {:else if done}
    <p class="text-sm text-muted-foreground">Nothing to do. The legacy call log is empty.</p>
  {/if}
</div>
