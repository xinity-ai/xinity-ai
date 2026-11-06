<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import DialogPanel from "$lib/components/DialogPanel.svelte";
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
  <DialogPanel class="max-w-3xl p-0">
    <div class="flex items-center justify-between p-6 pb-0">
      <h2 class="text-xl font-semibold">Roles & Permissions</h2>
      <Button variant="ghost" size="icon-sm" onclick={onClose}>
        <X class="w-4 h-4" />
      </Button>
    </div>

    <div class="p-6 max-h-[70vh] overflow-y-auto">
      <RolesPermissionMatrix />
    </div>
  </DialogPanel>
</Modal>
