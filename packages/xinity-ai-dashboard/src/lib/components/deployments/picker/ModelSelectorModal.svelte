<script lang="ts">
  import type { ComponentProps } from "svelte";
  import Modal from "$lib/components/Modal.svelte";
  import ModelSelector from "./ModelSelector.svelte";

  let {
    open = $bindable(false),
    searchTerm = $bindable(""),
    onClose,
    ...selector
  }: { open: boolean; searchTerm?: string; onClose: () => void } & Omit<ComponentProps<typeof ModelSelector>, "onClose" | "searchTerm"> = $props();
</script>

<Modal {open} {onClose} class="z-50">
  {#if open}
    <div class="bg-card rounded-xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">
      <ModelSelector {...selector} bind:searchTerm {onClose} />
    </div>
  {/if}
</Modal>
