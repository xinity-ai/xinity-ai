<!-- Modal.svelte -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { twMerge } from "tailwind-merge";
  import ToastContainer from "./ToastContainer.svelte";

  let {
    open = $bindable(false),
    children,
    onClose,
    class: className = "",
  }: {
    open: boolean;
    children: Snippet;
    onClose?: () => void;
    class?: string;
  } = $props();
  let dialog: HTMLDialogElement;

  // Imperative bridge, but still controlled by `open`
  $effect(() => {
    if (dialog) {
      if (open && !dialog.open) {
        dialog.showModal();
      } else if (!open && dialog.open) {
        dialog.close();
      }
    }
  });

  function handleClose() {
    // Keep prop in sync when user presses Esc or clicks backdrop
    open = false;
    onClose?.();
  }

  // Only close when the press starts on the backdrop itself.
  let backdropPress = false;
</script>

<dialog
  bind:this={dialog}
  onclose={handleClose}
  onpointerdown={(evt) => {
    if (evt.target === evt.currentTarget) {
      backdropPress = true;
    }
  }}
  onpointerup={(evt) => {
    if (evt.target === evt.currentTarget && backdropPress) {
      open = false; // update bound state
    }
    backdropPress = false;
  }}
  onpointercancel={() => {
    backdropPress = false;
  }}
  class={twMerge(
    className,
    "m-auto max-w-5/6 p-0 border-0 bg-transparent backdrop:bg-black/50",
  )}
>
  <!-- <div class="bg-white rounded-lg shadow-lg w-[90vw] max-w-md p-6">
  </div> -->
  {@render children()}

  <!-- Included to allow interactable toasts in modals -->
  <ToastContainer />
</dialog>
