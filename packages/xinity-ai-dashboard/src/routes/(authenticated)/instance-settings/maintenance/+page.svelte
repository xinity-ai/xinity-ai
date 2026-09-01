<script lang="ts">
  import { onMount } from "svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Database, HardDrive, TriangleAlert } from "@lucide/svelte";
  import { toastState } from "$lib/state/toast.svelte";

  const CALL_CHUNK = 250;
  const MEDIA_CHUNK = 50;

  let calls = $state({ remaining: null as number | null, done: 0, failed: 0, running: false, stop: false });
  let media = $state({ remaining: null as number | null, s3: false, done: 0, failed: 0, running: false, stop: false });

  async function refresh() {
    const [callResult, mediaResult] = await Promise.all([
      orpc.instanceAdmin.legacyCallStatus({}),
      orpc.instanceAdmin.mediaStorageStatus({}),
    ]);
    if (callResult.data) {
      calls.remaining = callResult.data.remaining;
    }
    if (mediaResult.data) {
      media.remaining = mediaResult.data.remaining;
      media.s3 = mediaResult.data.s3Configured;
    }
  }

  async function convertCalls() {
    calls.running = true;
    calls.stop = false;
    calls.done = 0;
    calls.failed = 0;

    while (!calls.stop) {
      const result = await orpc.instanceAdmin.convertLegacyCalls({ chunkSize: CALL_CHUNK });
      if (!result.data) {
        toastState.add("The conversion failed. Nothing was lost, see the server log.", "error");
        break;
      }
      calls.done += result.data.converted;
      calls.failed += result.data.failed;
      calls.remaining = result.data.remaining;

      if (result.data.remaining === 0) {
        toastState.add(`Converted ${calls.done} calls. Nothing is left in the old format.`, "success");
        break;
      }
      // A chunk that converts nothing would otherwise repeat the same failing rows forever.
      if (result.data.converted === 0) {
        toastState.add(`${result.data.remaining} calls could not be converted. See the server log.`, "error");
        break;
      }
    }

    calls.running = false;
  }

  async function moveMedia() {
    media.running = true;
    media.stop = false;
    media.done = 0;
    media.failed = 0;

    while (!media.stop) {
      const result = await orpc.instanceAdmin.moveMedia({ chunkSize: MEDIA_CHUNK });
      if (!result.data) {
        toastState.add("The move failed. No images were lost, see the server log.", "error");
        break;
      }
      media.done += result.data.moved;
      media.failed += result.data.failed;
      media.remaining = result.data.remaining;

      if (result.data.remaining === 0) {
        toastState.add(`Moved ${media.done} images into object storage.`, "success");
        break;
      }
      if (result.data.moved === 0) {
        toastState.add(`${result.data.remaining} images could not be moved. See the server log.`, "error");
        break;
      }
    }

    media.running = false;
  }

  const anythingToDo = $derived(
    (calls.remaining !== null && calls.remaining > 0) || (media.s3 && (media.remaining ?? 0) > 0),
  );

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

  {#if calls.remaining !== null && calls.remaining > 0}
    <Card.Root>
      <Card.Header>
        <Card.Title class="flex items-center gap-2">
          <Database class="size-4" />
          Convert old call log
        </Card.Title>
        <Card.Description>
          {calls.remaining.toLocaleString()} calls are still stored in the old format. Converting moves
          each one, with its messages and labels, into the current tables and removes the original.
          New calls are already written in the current format, so this only ever has to run once.
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        {#if calls.running || calls.done > 0}
          <p class="text-sm tabular-nums">
            Converted {calls.done.toLocaleString()}, {calls.remaining.toLocaleString()} remaining{#if calls.failed > 0}, <span class="text-destructive">{calls.failed.toLocaleString()} failed</span>{/if}
          </p>
        {/if}
        {#if calls.failed > 0}
          <p class="flex items-start gap-2 text-sm text-muted-foreground">
            <TriangleAlert class="mt-0.5 size-4 shrink-0" />
            Calls that fail are left untouched in the old format and logged on the server.
          </p>
        {/if}
        {#if calls.running}
          <Button variant="outline" onclick={() => (calls.stop = true)}>Stop</Button>
        {:else}
          <Button onclick={convertCalls}>Convert {calls.remaining.toLocaleString()} calls</Button>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}

  {#if media.s3 && media.remaining !== null && media.remaining > 0}
    <Card.Root>
      <Card.Header>
        <Card.Title class="flex items-center gap-2">
          <HardDrive class="size-4" />
          Move images to object storage
        </Card.Title>
        <Card.Description>
          {media.remaining.toLocaleString()} images are held in the database because no object storage
          was configured when they arrived. Object storage is configured now, so they can be moved out.
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        {#if media.running || media.done > 0}
          <p class="text-sm tabular-nums">
            Moved {media.done.toLocaleString()}, {media.remaining.toLocaleString()} remaining{#if media.failed > 0}, <span class="text-destructive">{media.failed.toLocaleString()} failed</span>{/if}
          </p>
        {/if}
        {#if media.failed > 0}
          <p class="flex items-start gap-2 text-sm text-muted-foreground">
            <TriangleAlert class="mt-0.5 size-4 shrink-0" />
            Images that fail keep their copy in the database and are logged on the server.
          </p>
        {/if}
        {#if media.running}
          <Button variant="outline" onclick={() => (media.stop = true)}>Stop</Button>
        {:else}
          <Button onclick={moveMedia}>Move {media.remaining.toLocaleString()} images</Button>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}

  {#if calls.remaining !== null && media.remaining !== null && !anythingToDo}
    <p class="text-sm text-muted-foreground">Nothing to do.</p>
  {/if}
</div>
