<script lang="ts">
import type { ApiKeyDto } from "$lib/orpc/dtos/api-key.dto";
import { orpc } from "$lib/orpc/orpc-client";
import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
import { toastState } from "$lib/state/toast.svelte";
import type { ApplicationDto } from "$lib/orpc/dtos/application.dto";
import { permissions } from "$lib/state/permissions.svelte";
import { invalidate } from "$app/navigation";

  // shadcn components
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import * as Tooltip from "$lib/components/ui/tooltip";

  // Icons
  import { Plus, Pencil, KeyRound, ChevronDown, ChevronUp, Info } from "@lucide/svelte";

  const locale = "de";
  const VISIBLE_KEY_COUNT = 10;
  type EditingKey = Pick<ApiKeyDto, "name" | "specifier" | "id" | "applicationId">;

  let {
    apiKeys,
    applications,
    showModal = $bindable(false),
    editingKey = $bindable(),
    userId,
  }: {
    apiKeys: ApiKeyDto[];
    applications: ApplicationDto[];
    showModal: boolean;
    editingKey: EditingKey;
    userId: string;
  } = $props();
  let keyToDelete: ApiKeyDto | null = $state(null);
  let showOlder = $state({ mine: false, org: false });

  const myKeys = $derived(apiKeys.filter((key) => key.createdByUserId === userId));
  const orgKeys = $derived(apiKeys.filter((key) => key.createdByUserId !== userId));
  const appMap = $derived(new Map(applications.map((app) => [app.id, app.name])));

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
    editingKey = { ...key };
    showModal = true;
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

    const { error } = await orpc.apiKey.delete({ id: deletingKey.id });
    if (error) {
      toastState.add("Error deleting API key", "error");
    } else {
      toastState.add(`Deleted API key "${deletingKey.name}"`, "success");
      invalidate("resource:apikeys");
    }
  }

  async function toggleEnabled(key: ApiKeyDto) {
    const newState = !key.enabled;
    const { error } = await orpc.apiKey.toggleEnabled({ id: key.id, enabled: newState });
    if (error) {
      toastState.add("Failed to update key status", "error");
    } else {
      if (!newState) {
        toastState.add(`Deactivated API key "${key.name}". It can keep working for up to 2 minutes.`, "success");
      }
      invalidate("resource:apikeys");
    }
  }

  async function toggleCollectData(key: ApiKeyDto) {
    const newState = !key.collectData;
    const { error } = await orpc.apiKey.toggleCollectData({ id: key.id, collectData: newState });
    if (error) {
      toastState.add("Failed to update key logging setting", "error");
    } else {
      invalidate("resource:apikeys");
    }
  }
</script>

{#snippet keyTable(keys: ApiKeyDto[], section: keyof typeof showOlder)}
  {@const olderCount = Math.max(keys.length - VISIBLE_KEY_COUNT, 0)}
  {@const visibleKeys = showOlder[section] ? keys : keys.slice(0, VISIBLE_KEY_COUNT)}
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
      {#each visibleKeys as key (key.id)}
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
            <div class="flex items-center gap-1.5">
              {key.createdAt.toLocaleDateString(locale, {
                dateStyle: "medium",
              })}
              {#if section === "org" && key.createdByUserName}
                <Tooltip.Provider>
                  <Tooltip.Root>
                    <Tooltip.Trigger class="text-muted-foreground hover:text-foreground" aria-label="Created by {key.createdByUserName}">
                      <Info class="w-3.5 h-3.5" />
                    </Tooltip.Trigger>
                    <Tooltip.Content>Created by {key.createdByUserName}</Tooltip.Content>
                  </Tooltip.Root>
                </Tooltip.Provider>
              {/if}
            </div>
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
                    onclick={() => toggleEnabled(key)}
                  >
                    {key.enabled ? "Deactivate" : "Activate"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => toggleCollectData(key)}
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
  {#if olderCount > 0}
    <Button
      variant="ghost"
      size="sm"
      class="w-full rounded-none border-t text-muted-foreground"
      aria-expanded={showOlder[section]}
      onclick={() => (showOlder[section] = !showOlder[section])}
    >
      {#if showOlder[section]}
        <ChevronUp class="w-4 h-4" />
        Hide older keys
      {:else}
        <ChevronDown class="w-4 h-4" />
        Show {olderCount} older {olderCount === 1 ? "key" : "keys"}
      {/if}
    </Button>
  {/if}
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
            {@render keyTable(myKeys, "mine")}
          </div>
        {/if}
        {#if orgKeys.length > 0}
          <div class="border-b last:border-b-0">
            <div class="px-4 py-2 compact:px-3 compact:py-1 bg-muted font-semibold text-sm">
              Organization Keys
            </div>
            {@render keyTable(orgKeys, "org")}
          </div>
        {/if}
      {/if}
    </div>
  </Card.Content>
</Card.Root>

<ConfirmDialog
  open={Boolean(keyToDelete)}
  title="Delete API Key"
  description="Are you sure you want to delete {keyToDelete?.name ?? 'this key'}? This action cannot be undone. The key can keep working for up to 2 minutes."
  confirmLabel="Delete"
  onConfirm={() => void confirmDelete()}
  onCancel={cancelDelete}
/>
