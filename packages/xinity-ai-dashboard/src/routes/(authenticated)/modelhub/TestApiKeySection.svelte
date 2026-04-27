<script lang="ts">
  import { onDestroy } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Sparkles, Trash2, Eye, EyeOff } from "@lucide/svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { toastState } from "$lib/state/toast.svelte";
  import { browserLogger } from "$lib/browserLogging";
  import { permissions } from "$lib/state/permissions.svelte";

  let {
    apiKey = $bindable(""),
    deploymentName,
  }: {
    apiKey: string;
    deploymentName: string;
  } = $props();

  const canCreateKey = $derived(permissions.can("apiKey", "create"));

  let showKey = $state(false);
  let temporaryKeyId = $state<string | null>(null);
  let creatingKey = $state(false);

  async function generate() {
    if (!canCreateKey || creatingKey) return;
    creatingKey = true;
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 12);
    const [error, result] = await orpc.apiKey.create({
      name: `Test - ${deploymentName} - ${stamp}`,
      enabled: true,
    });
    creatingKey = false;
    if (error) {
      browserLogger.warn({ error }, "Failed to create temporary test key");
      toastState.add("Failed to create temporary test key", "error");
      return;
    }
    apiKey = result.fullKey;
    showKey = true;
    toastState.add("Temporary test key created", "success");
    // create() returns the specifier but not the id; resolve via list so we
    // can soft-delete the key later.
    const [listError, list] = await orpc.apiKey.list({});
    if (!listError) {
      const created = list.find((k) => k.specifier === result.specifier);
      temporaryKeyId = created?.id ?? null;
    }
  }

  async function deleteNow() {
    if (!temporaryKeyId) return;
    const id = temporaryKeyId;
    temporaryKeyId = null;
    apiKey = "";
    showKey = false;
    const [error] = await orpc.apiKey.delete({ id });
    if (error) {
      browserLogger.warn({ error, id }, "Failed to delete temporary test key");
      toastState.add("Failed to delete temporary test key", "error");
    } else {
      toastState.add("Temporary test key deleted", "success");
    }
  }

  // Soft-delete the generated temp key when this section unmounts (modal
  // close). Fire-and-forget so the modal can close without waiting; toast on
  // both success and failure so the user sees the cleanup happened.
  onDestroy(() => {
    if (!temporaryKeyId) return;
    const id = temporaryKeyId;
    void orpc.apiKey.delete({ id }).then(([error]) => {
      if (error) {
        browserLogger.warn({ error, id }, "Failed to delete temporary test key on close");
        toastState.add("Failed to delete temporary test key", "error");
      } else {
        toastState.add("Temporary test key deleted", "success");
      }
    });
  });
</script>

<section class="space-y-2">
  <div class="flex items-center justify-between">
    <Label for="testApiKey" class="text-sm font-semibold">API Key</Label>
    {#if canCreateKey}
      <Button
        variant="ghost"
        size="sm"
        onclick={generate}
        disabled={creatingKey}
      >
        <Sparkles class="w-4 h-4" />
        {creatingKey ? "Creating..." : "Generate temporary key"}
      </Button>
    {/if}
  </div>
  <div class="flex items-center gap-2">
    <Input
      id="testApiKey"
      type={showKey ? "text" : "password"}
      bind:value={apiKey}
      placeholder="Paste an API key (sk_...)"
      class="font-mono text-xs"
      autocomplete="off"
    />
    <Button
      variant="outline"
      size="icon"
      onclick={() => (showKey = !showKey)}
      title={showKey ? "Hide" : "Show"}
    >
      {#if showKey}
        <EyeOff class="w-4 h-4" />
      {:else}
        <Eye class="w-4 h-4" />
      {/if}
    </Button>
    {#if temporaryKeyId}
      <Button
        variant="outline"
        size="icon"
        onclick={deleteNow}
        title="Delete generated key now"
      >
        <Trash2 class="w-4 h-4" />
      </Button>
    {/if}
  </div>
  {#if temporaryKeyId}
    <p class="text-xs text-muted-foreground">
      Temporary key created. It will be deleted automatically when you close this dialog.
    </p>
  {/if}
</section>
