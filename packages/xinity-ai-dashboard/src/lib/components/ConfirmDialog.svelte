<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button";
  import type { Snippet } from "svelte";

  let {
    open = $bindable(false),
    title,
    description,
    confirmLabel = "Confirm",
    confirmVariant = "destructive" as "destructive" | "default" | "outline" | "secondary" | "ghost" | "link",
    onConfirm,
    onCancel,
    children,
  }: {
    open: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    confirmVariant?: "destructive" | "default" | "outline" | "secondary" | "ghost" | "link";
    onConfirm: () => void;
    onCancel?: () => void;
    children?: Snippet;
  } = $props();

  function handleCancel() {
    open = false;
    onCancel?.();
  }
</script>

<Modal bind:open onClose={handleCancel}>
  <div class="bg-card rounded-xl border shadow-2xl max-w-md w-full p-6">
    <h2 class="text-lg font-semibold mb-4">{title}</h2>
    <div class="space-y-4">
      {#if description}
        <p class="text-sm text-muted-foreground">{description}</p>
      {/if}
      {#if children}
        {@render children()}
      {/if}
      <div class="flex justify-end gap-2">
        <Button variant="outline" onclick={handleCancel}>Cancel</Button>
        <Button variant={confirmVariant} onclick={onConfirm}>{confirmLabel}</Button>
      </div>
    </div>
  </div>
</Modal>
