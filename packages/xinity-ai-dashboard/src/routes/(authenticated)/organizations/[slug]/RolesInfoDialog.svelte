<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import RolesPermissionMatrix from "$lib/components/RolesPermissionMatrix.svelte";
  import { Button } from "$lib/components/ui/button";
  import { X } from "@lucide/svelte";

  let {
    open = $bindable(false),
    onClose,
  }: {
    open: boolean;
    onClose: () => void;
  } = $props();
</script>

<Modal bind:open {onClose}>
  <div class="bg-card rounded-xl border shadow-2xl max-w-3xl w-full">
    <div class="flex items-center justify-between p-6 pb-0">
      <h2 class="text-xl font-semibold">Roles & Permissions</h2>
      <Button variant="ghost" size="icon-sm" onclick={onClose}>
        <X class="w-4 h-4" />
      </Button>
    </div>

    <div class="p-6 max-h-[70vh] overflow-y-auto">
      <RolesPermissionMatrix />
    </div>
  </div>
</Modal>
