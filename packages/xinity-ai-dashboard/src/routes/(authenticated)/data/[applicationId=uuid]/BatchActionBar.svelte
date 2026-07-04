<script lang="ts">
  import { orpc } from "$lib/orpc/orpc-client";
  import { Button } from "$lib/components/ui/button";

  let {
    selectedCallIds,
    applications = [],
    canMove = false,
    onClear,
    onMoved,
  }: {
    selectedCallIds: Set<string>;
    applications?: { id: string; name: string }[];
    canMove?: boolean;
    onClear: () => void;
    onMoved: (ids: string[]) => void;
  } = $props();

  let reassignTarget = $state("");

  async function handleMove() {
    if (!reassignTarget) {
      return;
    }
    const ids = Array.from(selectedCallIds);
    const applicationId = reassignTarget === "uncategorized" ? null : reassignTarget;
    try {
      const [error] = await orpc.apiCall.reassignApplication({ apiCallIds: ids, applicationId });
      if (error) {
        throw error;
      }
      onMoved(ids);
      onClear();
    } catch (e) {
      console.error("Failed to reassign calls:", e);
    }
    reassignTarget = "";
  }
</script>

{#if selectedCallIds.size > 0}
  <div class="fixed bottom-6 left-1/2 -translate-x-1/2 bg-card border shadow-lg rounded-lg p-4 flex items-center gap-4 z-50">
    <span class="text-sm font-medium">
      {selectedCallIds.size} selected
    </span>
    <div class="flex items-center gap-2">
      {#if canMove}
        <select
          class="px-3 py-1.5 text-sm border rounded-md bg-background"
          bind:value={reassignTarget}
        >
          <option value="">Move to...</option>
          <option value="uncategorized">Uncategorized</option>
          {#each applications as app}
            <option value={app.id}>{app.name}</option>
          {/each}
        </select>
        <Button
          variant="outline"
          size="sm"
          onclick={() => void handleMove()}
          disabled={!reassignTarget}
        >
          Move
        </Button>
      {/if}
      <Button
        variant="ghost"
        size="sm"
        onclick={onClear}
      >
        Clear
      </Button>
    </div>
  </div>
{/if}
