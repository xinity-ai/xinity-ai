<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button";
  import { X } from "@lucide/svelte";

  let {
    metadata,
    open = $bindable(false),
    onSave,
  }: {
    metadata: Record<string, unknown>;
    open: boolean;
    onSave: (metadata: Record<string, unknown> | null) => void;
  } = $props();

  let entries = $state<[string, string][]>([]);
  let inputMode = $state<"key" | "value">("key");
  let currentKey = $state("");
  let inputText = $state("");
  let inputRef = $state<HTMLInputElement>(null!);

  $effect(() => {
    if (open) {
      entries = Object.entries(metadata).map(([k, v]) => [
        k,
        typeof v === "object" ? JSON.stringify(v) : String(v),
      ]);
      inputMode = "key";
      currentKey = "";
      inputText = "";
    }
  });

  function commitEntry() {
    const key = currentKey.trim();
    if (!key) {
      return;
    }
    entries = [...entries.filter(([k]) => k !== key), [key, inputText]];
    currentKey = "";
    inputText = "";
    inputMode = "key";
  }

  function removeEntry(key: string) {
    entries = entries.filter(([k]) => k !== key);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (inputMode === "key") {
      if ((e.key === "Tab" || e.key === "Enter") && inputText.trim()) {
        e.preventDefault();
        currentKey = inputText.trim();
        inputText = "";
        inputMode = "value";
      }
    } else {
      if (e.key === "Enter") {
        e.preventDefault();
        commitEntry();
      } else if (e.key === "Backspace" && inputText === "") {
        e.preventDefault();
        inputText = currentKey;
        currentKey = "";
        inputMode = "key";
      } else if (e.key === "Escape") {
        e.preventDefault();
        currentKey = "";
        inputText = "";
        inputMode = "key";
      }
    }
  }

  function handleSave() {
    if (currentKey.trim() && inputMode === "value") {
      commitEntry();
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    }
    onSave(Object.keys(result).length > 0 ? result : null);
  }
</script>

<Modal bind:open>
  <div class="bg-card rounded-xl border shadow-2xl max-w-md w-full p-6">
    <h3 class="text-lg font-semibold mb-4">Edit Metadata</h3>

    <label class="flex flex-wrap gap-2 p-3 min-h-[48px] border rounded-md bg-background mb-4 cursor-text">
      {#each entries as [key, value]}
        <span class="inline-flex items-center text-sm bg-muted rounded-md overflow-hidden">
          <span class="px-2 py-1 font-medium">{key}</span>
          <span class="w-px self-stretch bg-border"></span>
          <span class="px-2 py-1 text-muted-foreground">{value || '""'}</span>
          <button
            type="button"
            class="px-1.5 py-1 hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer"
            onclick={() => removeEntry(key)}
          >
            <X class="w-3 h-3" />
          </button>
        </span>
      {/each}

      <span class="inline-flex items-center flex-1 min-w-[120px]">
        {#if inputMode === "value"}
          <span class="inline-flex items-center text-sm bg-primary/10 text-primary rounded-l-md px-2 py-1 font-medium">
            {currentKey}
          </span>
        {/if}
        <input
          bind:this={inputRef}
          type="text"
          class="flex-1 min-w-[80px] px-2 py-1 text-sm bg-transparent outline-none"
          placeholder={inputMode === "key" ? "Add key..." : "Value, then Enter"}
          bind:value={inputText}
          onkeydown={handleKeydown}
        />
      </span>
    </label>

    <p class="text-xs text-muted-foreground mb-4">
      Type a key, press Tab to set its value, then Enter to add.
    </p>

    <div class="flex justify-end gap-2">
      <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
      <Button onclick={handleSave}>Save</Button>
    </div>
  </div>
</Modal>
