<script lang="ts">
  import { passkey } from "$lib/auth";
  import { orpc } from "$lib/orpc/orpc-client";
  import { browserLogger } from "$lib/browserLogging";
  import { toastState } from "$lib/state/toast.svelte";
  import { humanDate } from "$lib/util";

  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Alert from "$lib/components/ui/alert";
  import Modal from "$lib/components/Modal.svelte";

  import { Plus, Trash2, Key, Loader2 } from "@lucide/svelte";

  let passkeys = $state<any[]>([]);
  let isLoading = $state(true);
  let loadError = $state("");

  let createDialogOpen = $state(false);
  let deleteDialogOpen = $state(false);
  let passKeyName = $state("");
  let confirmDelete: { id: string; name?: string } | null = $state(null);

  async function loadPasskeys() {
    isLoading = true;
    const [error, data] = await orpc.account.listPasskeys({});
    isLoading = false;
    if (error) {
      loadError = error.message;
    } else {
      passkeys = data ?? [];
    }
  }

  loadPasskeys();

  async function createNewPasskey() {
    const resp = await passkey.addPasskey({ name: passKeyName });
    if (resp && resp.error) {
      browserLogger.error(resp.error, "Error during passkey Creation");
      toastState.add("Error during passkey creation", "error");
    } else {
      toastState.add("Passkey created successfully", "success");
    }
    await loadPasskeys();
    createDialogOpen = false;
    passKeyName = "";
  }

  function askDeletePasskey(key: { id: string; name?: string }) {
    confirmDelete = key;
    deleteDialogOpen = true;
  }

  async function doDeletePasskey() {
    if (!confirmDelete) return;

    const { id, name } = confirmDelete;
    confirmDelete = null;
    deleteDialogOpen = false;

    const [error] = await orpc.account.deletePasskey({ id });
    if (error) {
      browserLogger.error(error, "Error deleting passkey");
      toastState.add("Error deleting passkey", "error");
    } else {
      toastState.add("Passkey deleted", "success");
      await loadPasskeys();
    }
  }
</script>

<div class="space-y-4">
  <div class="flex justify-end">
    <Button size="sm" onclick={() => (createDialogOpen = true)}>
      <Plus class="w-4 h-4" />
      Create Passkey
    </Button>
  </div>

  <div class="border rounded-lg">
    {#if isLoading}
      <div class="flex items-center justify-center p-8">
        <Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
        <span class="ml-2 text-sm text-muted-foreground">Loading passkeys...</span>
      </div>
    {:else if loadError}
      <Alert.Root variant="destructive" class="m-4">
        <Alert.Description>{loadError}</Alert.Description>
      </Alert.Root>
    {:else if passkeys.length === 0}
      <div class="flex flex-col items-center justify-center p-8 text-center">
        <div class="flex items-center justify-center w-12 h-12 mb-4 rounded-full bg-muted">
          <Key class="w-6 h-6 text-muted-foreground" />
        </div>
        <p class="text-sm text-muted-foreground mb-4">No passkeys yet.</p>
        <Button size="sm" onclick={() => (createDialogOpen = true)}>
          <Plus class="w-4 h-4" />
          Create your first passkey
        </Button>
      </div>
    {:else}
      <ul class="divide-y">
        {#each passkeys as key (key.id)}
          <li class="flex items-center justify-between gap-3 p-4">
            <div class="min-w-0">
              <p class="font-medium truncate">
                {key.name || "Unnamed passkey"}
              </p>
              <p class="text-sm text-muted-foreground">
                Created {humanDate(key.createdAt)}
              </p>
            </div>

            <Button
              variant="destructive"
              size="sm"
              onclick={() => askDeletePasskey(key)}
            >
              <Trash2 class="w-4 h-4" />
              Delete
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<!-- Create Passkey Modal -->
<Modal bind:open={createDialogOpen} class="max-w-md">
  <div class="bg-card rounded-xl shadow-2xl w-full p-6 space-y-4">
    <div>
      <h3 class="text-lg font-semibold">Create a passkey</h3>
      <p class="text-sm text-muted-foreground">
        Give your passkey a friendly name (e.g., "MacBook").
      </p>
    </div>

    <form
      onsubmit={(e) => {
        e.preventDefault();
        createNewPasskey();
      }}
      class="space-y-4"
    >
      <div class="space-y-2">
        <Label for="passkey-name">Name</Label>
        <Input
          id="passkey-name"
          type="text"
          required
          bind:value={passKeyName}
          placeholder="e.g., MacBook"
        />
      </div>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" onclick={() => (createDialogOpen = false)}>
          Cancel
        </Button>
        <Button type="submit">Create</Button>
      </div>
    </form>
  </div>
</Modal>

<!-- Delete Passkey Modal -->
<Modal bind:open={deleteDialogOpen} class="max-w-md">
  <div class="bg-card rounded-xl shadow-2xl w-full p-6 space-y-4">
    <div>
      <h3 class="text-lg font-semibold">Delete passkey?</h3>
      <p class="text-sm text-muted-foreground">
        {#if confirmDelete}
          This will remove "{confirmDelete.name || "Unnamed passkey"}". You can't undo this.
        {/if}
      </p>
    </div>

    <div class="flex justify-end gap-2">
      <Button variant="outline" onclick={() => (deleteDialogOpen = false)}>
        Cancel
      </Button>
      <Button variant="destructive" onclick={doDeletePasskey}>
        Delete
      </Button>
    </div>
  </div>
</Modal>
