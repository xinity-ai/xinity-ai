<script lang="ts">
  import { toastState } from "$lib/state/toast.svelte";
  import Toast from "./Toast.svelte";
</script>

<div
  class="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2 pointer-events-none"
>
  {#each toastState.toasts as toast (toast.id)}
    <div class="pointer-events-auto">
      <Toast {toast} />
    </div>
  {/each}
</div>
