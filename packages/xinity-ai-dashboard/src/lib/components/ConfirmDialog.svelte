<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import DialogPanel from "$lib/components/DialogPanel.svelte";
  import { Button, type ButtonVariant } from "$lib/components/ui/button";
  import { LoaderCircle } from "@lucide/svelte";
  import type { Snippet } from "svelte";

  let {
    open = $bindable(false),
    title,
    description,
    confirmLabel = "Confirm",
    confirmVariant = "destructive",
    pending = false,
    onConfirm,
    onCancel,
    children,
  }: {
    open: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    confirmVariant?: ButtonVariant;
    pending?: boolean;
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
  <DialogPanel>
    <h2 class="text-lg font-semibold mb-4">{title}</h2>
    <div class="space-y-4">
      {#if description}
        <p class="text-sm text-muted-foreground">{description}</p>
      {/if}
      {#if children}
        {@render children()}
      {/if}
      <div class="flex justify-end gap-2">
        <Button variant="outline" disabled={pending} onclick={handleCancel}>Cancel</Button>
        <Button variant={confirmVariant} disabled={pending} onclick={onConfirm}>
          {#if pending}
            <LoaderCircle class="w-4 h-4 animate-spin" />
          {/if}
          {confirmLabel}
        </Button>
      </div>
    </div>
  </DialogPanel>
</Modal>
