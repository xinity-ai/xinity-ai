<script lang="ts">
  import { orpc } from "$lib/orpc/orpc-client";
  import { browserLogger } from "$lib/browserLogging";
  import { copyToClipboard } from "$lib/copy";
  import { toastState } from "$lib/state/toast.svelte";
  import { humanDate } from "$lib/util";

  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Alert from "$lib/components/ui/alert";
  import Modal from "$lib/components/Modal.svelte";

  import { Plus, Trash2, Key, Loader2, Copy } from "@lucide/svelte";

  let apiKeys = $state<any[]>([]);
  let organizations = $state<any[]>([]);
  let isLoading = $state(true);
  let loadError = $state("");

  let createDialogOpen = $state(false);
  let deleteDialogOpen = $state(false);
  let apiKeyToDelete: string | null = $state(null);

  let newKeyName = $state("");
  let newKeyOrgId = $state("");
  let isCreating = $state(false);
  let createdKey = $state<string | null>(null);
  let createError = $state("");

  async function loadApiKeys() {
    isLoading = true;
    const [error, data] = await orpc.account.listDashboardApiKeys({});
    isLoading = false;
    if (error) {
      loadError = error.message;
      browserLogger.error(error, "Error during API key loading");
    } else {
      apiKeys = data ?? [];
    }
  }

  async function loadOrganizations() {
    const [error, data] = await orpc.organization.list({});
    if (error) {
      browserLogger.error(error, "Error during organizations loading");
      toastState.add("Error loading organizations", "error");
    } else {
      organizations = data ?? [];
    }
  }

  loadApiKeys();
  loadOrganizations();

  function openCreateDialog() {
    createdKey = null;
    createError = "";
    newKeyName = "";
    newKeyOrgId = "";
    createDialogOpen = true;
  }

  function closeCreateDialog() {
    createdKey = null;
    createDialogOpen = false;
  }

  async function handleCreate() {
    createError = "";

    if (!newKeyName || newKeyName.length < 3) {
      createError = "Name must be at least 3 characters";
      return;
    }
    if (!newKeyOrgId) {
      createError = "Please select an organization";
      return;
    }

    isCreating = true;
    const [error, data] = await orpc.account.createDashboardApiKey({
      name: newKeyName,
      organizationId: newKeyOrgId,
    });
    isCreating = false;

    if (error) {
      createError = error.message;
      toastState.add("Error creating API key", "error");
    } else {
      createdKey = data.key;
      toastState.add("API key created", "success");
      await loadApiKeys();
    }
  }

  function openDeleteDialog(id: string) {
    apiKeyToDelete = id;
    deleteDialogOpen = true;
  }

  async function doDeleteApiKey() {
    if (!apiKeyToDelete) return;

    const id = apiKeyToDelete;
    apiKeyToDelete = null;
    deleteDialogOpen = false;

    const [error] = await orpc.account.deleteDashboardApiKey({ id });
    if (error) {
      browserLogger.error(error, "Error deleting API key");
      toastState.add("Error deleting API key", "error");
    } else {
      toastState.add("API key deleted", "success");
      apiKeys = apiKeys.filter((key) => key.id !== id);
    }
  }
</script>

<div class="space-y-4">
  <div class="flex justify-end">
    <Button size="sm" onclick={openCreateDialog}>
      <Plus class="w-4 h-4" />
      Create API Key
    </Button>
  </div>

  <div class="border rounded-lg">
    {#if isLoading}
      <div class="flex items-center justify-center p-8">
        <Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
        <span class="ml-2 text-sm text-muted-foreground">Loading API keys...</span>
      </div>
    {:else if loadError}
      <Alert.Root variant="destructive" class="m-4">
        <Alert.Description>{loadError}</Alert.Description>
      </Alert.Root>
    {:else if apiKeys.length === 0}
      <div class="flex flex-col items-center justify-center p-8 text-center">
        <div class="flex items-center justify-center w-12 h-12 mb-4 rounded-full bg-muted">
          <Key class="w-6 h-6 text-muted-foreground" />
        </div>
        <p class="text-sm text-muted-foreground mb-4">No API keys yet.</p>
        <Button size="sm" onclick={openCreateDialog}>
          <Plus class="w-4 h-4" />
          Create your first API key
        </Button>
      </div>
    {:else}
      <ul class="divide-y">
        {#each apiKeys as key (key.id)}
          <li class="flex items-center justify-between gap-3 p-4">
            <div class="min-w-0">
              <p class="font-medium truncate">
                {key.name || "Unnamed API Key"}
              </p>
              <p class="text-sm text-muted-foreground">
                Created {humanDate(key.createdAt)}
              </p>
            </div>

            <Button
              variant="destructive"
              size="sm"
              onclick={() => openDeleteDialog(key.id)}
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

<!-- Create API Key Modal -->
<Modal bind:open={createDialogOpen} class="max-w-md">
  <div class="bg-card rounded-xl shadow-2xl w-full p-6 space-y-4">
    <h3 class="text-lg font-semibold">Create API Key</h3>

    {#if createdKey}
      <div class="space-y-4">
        <div class="space-y-2">
          <Label for="fullKey">Key Value</Label>
          <div class="flex items-center gap-2">
            <Input
              id="fullKey"
              type="text"
              value={createdKey}
              readonly
              class="font-mono text-sm"
            />
            <Button
              variant="outline"
              size="icon"
              onclick={() => copyToClipboard(createdKey!)}
              title="Copy API key"
            >
              <Copy class="w-4 h-4" />
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            Make sure to copy this key now. You won't be able to see the full key again.
          </p>
        </div>

        <div class="flex justify-end">
          <Button onclick={closeCreateDialog}>Close</Button>
        </div>
      </div>
    {:else}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
        class="space-y-4"
      >
        <p class="text-sm text-muted-foreground">
          Give your API key a friendly name.
        </p>

        <div class="space-y-2">
          <Label for="api-key-name">Name</Label>
          <Input
            id="api-key-name"
            type="text"
            required
            minlength={3}
            bind:value={newKeyName}
            placeholder="e.g., Integration 12"
          />
        </div>

        <div class="space-y-2">
          <Label for="api-key-org">Organization</Label>
          <select
            id="api-key-org"
            bind:value={newKeyOrgId}
            class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">Select an organization</option>
            {#each organizations as org}
              <option value={org.id}>{org.name}</option>
            {/each}
          </select>
        </div>

        {#if createError}
          <p class="text-sm text-destructive">{createError}</p>
        {/if}

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" onclick={closeCreateDialog}>
            Cancel
          </Button>
          <Button type="submit" disabled={isCreating}>
            {#if isCreating}
              <Loader2 class="w-4 h-4 animate-spin" />
              Creating...
            {:else}
              Create
            {/if}
          </Button>
        </div>
      </form>
    {/if}
  </div>
</Modal>

<!-- Delete API Key Modal -->
<Modal bind:open={deleteDialogOpen} class="max-w-md">
  <div class="bg-card rounded-xl shadow-2xl w-full p-6 space-y-4">
    <div>
      <h3 class="text-lg font-semibold">Delete API Key</h3>
      <p class="text-sm text-muted-foreground">
        Delete "{apiKeys.find((key) => key.id === apiKeyToDelete)?.name || "Unknown"}"? This action cannot be undone.
      </p>
    </div>

    <div class="flex justify-end gap-2">
      <Button variant="outline" onclick={() => (deleteDialogOpen = false)}>
        Cancel
      </Button>
      <Button variant="destructive" onclick={doDeleteApiKey}>
        Delete
      </Button>
    </div>
  </div>
</Modal>
