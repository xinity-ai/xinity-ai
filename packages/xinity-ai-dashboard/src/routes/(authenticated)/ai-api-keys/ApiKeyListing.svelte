<script lang="ts">
  import { ApiKeyDto } from "$lib/orpc/dtos/api-key.dto";
  import { orpc } from "$lib/orpc/orpc-client";
  import { updateOptimistically } from "$lib/util";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { toastState } from "$lib/state/toast.svelte";
  import type { ApplicationDto } from "$lib/orpc/dtos/application.dto";
  import { permissions } from "$lib/state/permissions.svelte";

  // shadcn components
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";

  // Icons
  import { Plus, Pencil, KeyRound } from "@lucide/svelte";

  const locale = "de";
  type EditingKey = Pick<ApiKeyDto, "name" | "specifier" | "id" | "applicationId">;

  export let apiKeys: ApiKeyDto[];
  export let applications: ApplicationDto[];
  export let showModal = false;
  export let editingKey: EditingKey;
  export let userId: string;
  let keyToDelete: ApiKeyDto | null = null;

  // Group API keys by ownership
  $: myKeys = apiKeys.filter((key) => key.createdByUserId === userId);
  $: orgKeys = apiKeys.filter((key) => key.createdByUserId !== userId);

  $: appMap = new Map(applications.map((app) => [app.id, app.name]));

  function generateNewKey() {
    editingKey = {
      name: "",
      specifier: "",
      id: "",
      applicationId: null,
    };
    showModal = true;
  }

  function editKey(key: EditingKey) {
    if (key) {
      editingKey = { name: key.name, specifier: key.specifier, id: key.id, applicationId: key.applicationId };
      showModal = true;
    }
  }

  function requestDelete(key: ApiKeyDto) {
    keyToDelete = key;
  }

  function cancelDelete() {
    keyToDelete = null;
  }

  async function confirmDelete() {
    if (!keyToDelete) return;
    const deletingKey = keyToDelete;
    keyToDelete = null;
    const apiKeysBefore = apiKeys;
    let failed = false;

    await updateOptimistically({
      apiPromise: () => orpc.apiKey.delete({ id: deletingKey.id }),
      update: () => (apiKeys = apiKeys.filter((v) => v !== deletingKey)),
      undo: () => {
        apiKeys = apiKeysBefore;
        failed = true;
        toastState.add("Error deleting API key", "error");
      },
    });

    if (!failed) {
      toastState.add(`Deleted API key "${deletingKey.name}"`, "success");
    }
  }
</script>

{#snippet keyTable(keys: ApiKeyDto[])}
  <table class="min-w-full">
    <thead class="bg-muted/50">
      <tr>
        <th class="px-6 py-3 compact:px-3 compact:py-1.5 text-xs font-medium tracking-wider text-left text-muted-foreground uppercase">
          Name
        </th>
        <th class="px-6 py-3 compact:px-3 compact:py-1.5 text-xs font-medium tracking-wider text-left text-muted-foreground uppercase">
          API Key
        </th>
        <th class="px-6 py-3 compact:px-3 compact:py-1.5 text-xs font-medium tracking-wider text-left text-muted-foreground uppercase">
          Application
        </th>
        <th class="px-6 py-3 compact:px-3 compact:py-1.5 text-xs font-medium tracking-wider text-left text-muted-foreground uppercase">
          Created
        </th>
        <th class="px-6 py-3 compact:px-3 compact:py-1.5 text-xs font-medium tracking-wider text-left text-muted-foreground uppercase">
          Status
        </th>
        {#if permissions.can("apiKey", "update") || permissions.can("apiKey", "delete")}
          <th class="px-6 py-3 compact:px-3 compact:py-1.5 text-xs font-medium tracking-wider text-left text-muted-foreground uppercase">
            Actions
          </th>
        {/if}
      </tr>
    </thead>
    <tbody class="divide-y">
      {#each keys as key}
        <tr>
          <td class="px-6 py-4 compact:px-3 compact:py-2 whitespace-nowrap">
            <div class="flex items-center text-sm font-medium">
              <span title={key.name} class="truncate lg:max-w-40 md:max-w-20 max-w-10">
                {key.name}
              </span>
              {#if permissions.can("apiKey", "update")}
                <Button
                  variant="ghost"
                  size="icon"
                  class="ml-1 h-7 w-7"
                  onclick={() => editKey(key)}
                  aria-label="Edit key"
                  title="Edit key"
                >
                  <Pencil class="w-3.5 h-3.5" />
                </Button>
              {/if}
            </div>
          </td>
          <td class="px-6 py-4 compact:px-3 compact:py-2 whitespace-nowrap">
            <code class="text-sm text-muted-foreground">
              {key.specifier?.substring(0, 8)}...
            </code>
          </td>
          <td class="px-6 py-4 compact:px-3 compact:py-2 whitespace-nowrap text-sm">
            {#if key.applicationId}
              <Badge variant="outline">{appMap.get(key.applicationId) || "Unknown"}</Badge>
            {:else}
              <span class="text-muted-foreground">None</span>
            {/if}
          </td>
          <td class="px-6 py-4 compact:px-3 compact:py-2 whitespace-nowrap text-sm">
            {key.createdAt.toLocaleDateString(locale, {
              dateStyle: "medium",
            })}
          </td>
          <td class="px-6 py-4 compact:px-3 compact:py-2 whitespace-nowrap">
            <div class="flex gap-1.5 flex-wrap">
              {#if key.enabled}
                <Badge variant="default" class="bg-green-100 text-green-800 hover:bg-green-100">
                  Active
                </Badge>
              {:else}
                <Badge variant="destructive" class="bg-red-100 text-red-800 hover:bg-red-100">
                  Inactive
                </Badge>
              {/if}
              {#if !key.collectData}
                <Badge variant="outline" class="text-muted-foreground">
                  No Logging
                </Badge>
              {/if}
            </div>
          </td>
          {#if permissions.can("apiKey", "update") || permissions.can("apiKey", "delete")}
            <td class="px-6 py-4 compact:px-3 compact:py-2 text-sm whitespace-nowrap">
              <div class="flex gap-2">
                {#if permissions.can("apiKey", "update")}
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={async () => {
                      const newState = !key.enabled;
                      updateOptimistically({
                        apiPromise: () =>
                          orpc.apiKey.toggleEnabled({
                            id: key.id,
                            enabled: newState,
                          }),
                        update: () => (key.enabled = newState),
                        undo: () => (key.enabled = !newState),
                      });
                    }}
                  >
                    {key.enabled ? "Deactivate" : "Activate"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={async () => {
                      const newState = !key.collectData;
                      updateOptimistically({
                        apiPromise: () =>
                          orpc.apiKey.toggleCollectData({
                            id: key.id,
                            collectData: newState,
                          }),
                        update: () => (key.collectData = newState),
                        undo: () => (key.collectData = !newState),
                      });
                    }}
                  >
                    {key.collectData ? "Stop Logging" : "Start Logging"}
                  </Button>
                {/if}
                {#if permissions.can("apiKey", "delete")}
                  <Button
                    variant="ghost"
                    size="sm"
                    class="text-destructive hover:text-destructive"
                    onclick={() => requestDelete(key)}
                  >
                    Delete
                  </Button>
                {/if}
              </div>
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

<!-- API Keys Section -->
<Card.Root class="lg:col-span-3">
  <Card.Header>
    <div class="flex items-center justify-between">
      <div>
        <Card.Title>API Keys</Card.Title>
        <Card.Description>Manage your API keys securely.</Card.Description>
      </div>
      {#if permissions.can("apiKey", "create")}
        <Button onclick={generateNewKey}>
          <Plus class="w-4 h-4" />
          Generate New Key
        </Button>
      {/if}
    </div>
  </Card.Header>
  <Card.Content>
    <div class="overflow-auto border rounded-lg">
      {#if apiKeys.length === 0}
        <div class="flex flex-col items-center py-12 compact:py-6 text-center">
          <div class="flex items-center justify-center w-12 h-12 mb-4 rounded-full bg-muted">
            <KeyRound class="w-6 h-6 text-muted-foreground" />
          </div>
          <p class="text-sm text-muted-foreground mb-4">No API keys created yet.</p>
          {#if permissions.can("apiKey", "create")}
            <Button size="sm" onclick={generateNewKey}>
              <Plus class="w-4 h-4" />
              Create Your First Key
            </Button>
          {/if}
        </div>
      {:else}
        {#if myKeys.length > 0}
          <div class="border-b last:border-b-0">
            <div class="px-4 py-2 compact:px-3 compact:py-1 bg-muted font-semibold text-sm">
              Your Keys
            </div>
            {@render keyTable(myKeys)}
          </div>
        {/if}
        {#if orgKeys.length > 0}
          <div class="border-b last:border-b-0">
            <div class="px-4 py-2 compact:px-3 compact:py-1 bg-muted font-semibold text-sm">
              Organization Keys
            </div>
            {@render keyTable(orgKeys)}
          </div>
        {/if}
      {/if}
    </div>
  </Card.Content>
</Card.Root>

<ConfirmDialog
  open={Boolean(keyToDelete)}
  title="Delete API Key"
  description="Are you sure you want to delete {keyToDelete?.name ?? 'this key'}? This action cannot be undone."
  confirmLabel="Delete"
  onConfirm={() => void confirmDelete()}
  onCancel={cancelDelete}
/>
