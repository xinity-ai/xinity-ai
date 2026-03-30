<script lang="ts">
  import { fly, fade } from "svelte/transition";
  import { toastState, type Toast as ToastType } from "$lib/state/toast.svelte";

  let { toast }: { toast: ToastType } = $props();

  const typeStyles = {
    success: "bg-green-50 border-green-500 text-green-800",
    error: "bg-red-50 border-red-500 text-red-800",
    info: "bg-xinity-magenta/10 border-xinity-purple text-xinity-pink",
    warning: "bg-yellow-50 border-yellow-500 text-yellow-800",
  };

  const iconStyles = {
    success: "text-green-500",
    error: "text-red-500",
    info: "text-xinity-magenta",
    warning: "text-yellow-500",
  };
</script>

<div
  class="flex items-start w-full max-w-sm p-4 mb-2 bg-white border-l-4 rounded shadow-lg {typeStyles[
    toast.type
  ]}"
  role="alert"
  in:fly={{ x: 200, duration: 300 }}
  out:fade={{ duration: 200 }}
>
  <div class="flex-1 text-sm font-medium wrap-break-word">
    {toast.message}
  </div>
  <button
    type="button"
    class="ml-4 -mx-1.5 -my-1.5 rounded-lg focus:ring-2 focus:ring-gray-300 p-1.5 inline-flex items-center justify-center h-8 w-8 opacity-50 hover:opacity-100 transition-opacity"
    aria-label="Close"
    onclick={() => toastState.remove(toast.id)}
  >
    <span class="sr-only">Close</span>
    <svg
      class="w-3 h-3"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 14 14"
    >
      <path
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="m1 1 6 6m0 0 6 6M7 7l6-6M7 7l-6 6"
      />
    </svg>
  </button>
</div>
