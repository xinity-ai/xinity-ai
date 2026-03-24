<script lang="ts">
  import { invalidate } from "$app/navigation";
  import Modal from "$lib/components/Modal.svelte";
  import { copyToClipboard } from "$lib/copy";
  import { ApiKeyDto } from "$lib/orpc/dtos/api-key.dto";
  import { orpc } from "$lib/orpc/orpc-client";
  import { toastState } from "$lib/state/toast.svelte";

  // shadcn components
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Alert from "$lib/components/ui/alert";

  // Icons
  import { Copy } from "@lucide/svelte";

  // Variable declarations
  export let editingKey: Pick<ApiKeyDto, "name" | "specifier" | "id" | "applicationId"> = {
    name: "",
    specifier: "",
    id: "",
    applicationId: null,
  };
  export let showModal = false;
  export let applications: {
    id: string;
    name: string;
    description?: string | null;
  }[] = [];

  $: isNew = !editingKey?.id;

  let fullCreatedKeyValue = "";
  let saving = false;

  // Application selection state
  let selectedApplicationId = "__none__";
  let newApplicationDescription = "";

  // Sync selectedApplicationId when opening the modal for editing
  $: if (showModal && !isNew) {
    selectedApplicationId = editingKey.applicationId ?? "__none__";
  }

  // Smart defaults
  $: willCreateApplication = selectedApplicationId === "__new__";
  $: noApplication = selectedApplicationId === "" || selectedApplicationId === "__none__";

  // Sync application name with key name when creating new application
  $: newApplicationName = willCreateApplication ? editingKey.name : "";

  async function createKey() {
    saving = true;

    const createPayload: any = {
      name: editingKey.name,
      enabled: true,
    };

    // Determine application handling
    if (willCreateApplication) {
      if (!editingKey.name.trim()) {
        toastState.add("Please enter a name for the API key", "error");
        saving = false;
        return;
      }
      createPayload.createApplication = {
        name: editingKey.name,
        description: newApplicationDescription || undefined,
      };
    } else if (!noApplication) {
      createPayload.applicationId = selectedApplicationId;
    }
    // If noApplication: key is created without a default application

    const { error, data: key } = await orpc.apiKey.create(createPayload);

    if (error) {
      console.error(error);
      toastState.add("Failed to create API key", "error");
      saving = false;
    } else {
      fullCreatedKeyValue = key.fullKey;
      editingKey.specifier = key.specifier;
      saving = false;
      invalidate("resource:apikeys");
    }
  }

  async function saveKey() {
    saving = true;

    const applicationId = noApplication ? null : selectedApplicationId;

    const { error } = await orpc.apiKey.update({
      name: editingKey.name,
      id: editingKey.id,
      applicationId,
    });

    if (error) {
      console.error(error);
      toastState.add("Failed to update API key", "error");
    } else {
      toastState.add("API key updated", "success");
    }
    invalidate("resource:apikeys");
    saving = false;
    showModal = false;
  }

  function cancelEdit() {
    showModal = false;
    fullCreatedKeyValue = "";
    // Reset state
    selectedApplicationId = "";
    newApplicationDescription = "";
  }

  let nameInput: HTMLElement;

  $: if (showModal && nameInput) {
    nameInput.focus();
  }
</script>

<!-- Key Edit Modal -->
<Modal open={showModal} onClose={cancelEdit}>
  <form
    onsubmit={(e) => { e.preventDefault(); isNew ? createKey() : saveKey(); }}
    class="w-full max-w-md p-6 bg-card rounded-lg shadow-xl space-y-4"
    data-apikeyid={editingKey.id}
  >
    <h3 class="text-lg font-semibold">
      {isNew ? "Generate New API Key" : "Edit API Key"}
    </h3>

    <div class="space-y-2">
      <Label for="keyName">Key Name</Label>
      <input
        type="text"
        id="keyName"
        bind:value={editingKey.name}
        bind:this={nameInput}
        placeholder="e.g., Production API, Mobile App, etc."
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    </div>

    <div class="space-y-2">
      <Label for="appSelect">Default Application</Label>
      <select
        id="appSelect"
        bind:value={selectedApplicationId}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="__none__">No default application</option>
        {#if isNew}
          <option value="__new__">
            Create new application "{editingKey.name || "..."}"
          </option>
        {/if}
        {#each applications as app}
          <option value={app.id}>{app.name}</option>
        {/each}
      </select>
      {#if noApplication}
        <p class="text-xs text-muted-foreground">
          Calls will be uncategorized unless you send an X-Application header.
        </p>
      {/if}
    </div>

    {#if isNew && willCreateApplication}
      <Alert.Root class="bg-primary/5 border-primary/20">
        <Alert.Description>
          <p class="text-sm font-medium mb-2">Creating new application</p>
          <div class="space-y-2">
            <Label for="appDesc" class="text-xs">Description (optional)</Label>
            <textarea
              id="appDesc"
              bind:value={newApplicationDescription}
              placeholder="Describe the purpose of this application..."
              rows="2"
              class="flex min-h-15 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            ></textarea>
          </div>
        </Alert.Description>
      </Alert.Root>
    {/if}

    {#if fullCreatedKeyValue}
      <div class="space-y-2">
        <Label for="fullKey">Key Value</Label>
        <div class="flex items-center gap-2">
          <Input
            id="fullKey"
            type="text"
            value={fullCreatedKeyValue}
            readonly
            class="font-mono text-sm"
          />
          <Button
            variant="outline"
            size="icon"
            type="button"
            onclick={() => copyToClipboard(fullCreatedKeyValue)}
            title="Copy API key"
          >
            <Copy class="w-4 h-4" />
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          Make sure to copy this key now. You won't be able to see the full key again.
        </p>
      </div>
    {:else if !isNew}
      <div class="space-y-2">
        <Label for="fullKey">Key Value</Label>
        <Input
          id="fullKey"
          type="text"
          value="{editingKey.specifier.substring(0, 8)}..."
          readonly
          class="font-mono text-sm bg-muted"
        />
        <p class="text-xs text-muted-foreground">
          The start of the key is shown for ease of identification
        </p>
      </div>
    {/if}

    <div class="flex justify-end gap-3 pt-2">
      {#if fullCreatedKeyValue}
        <Button onclick={cancelEdit}>OK</Button>
      {:else}
        <Button variant="outline" type="button" onclick={cancelEdit}>Cancel</Button>
        <Button type="submit" disabled={saving}>
          {#if isNew}
            {saving ? "Creating..." : "Create"}
          {:else}
            {saving ? "Saving..." : "Save"}
          {/if}
        </Button>
      {/if}
    </div>
  </form>
</Modal>
