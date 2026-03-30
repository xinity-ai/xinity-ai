<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import Modal from "$lib/components/Modal.svelte";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  type ParsedProvider = {
    id: string;
    providerId: string;
    issuer: string;
    domain: string;
    type: "oidc" | "saml";
    oidcConfig: { clientId?: string | null } | null;
    samlConfig: { entryPoint?: string | null } | null;
  };

  let {
    providers = [],
    loading = false,
    error = null,
    highlightedProviderId = null,
    onDelete,
  }: {
    providers?: ParsedProvider[];
    loading?: boolean;
    error?: Error | null;
    highlightedProviderId?: string | null;
    onDelete?: (providerId: string) => Promise<void>;
  } = $props();

  let deleteTarget = $state<ParsedProvider | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state(false);

  function confirmDelete(provider: ParsedProvider) {
    deleteTarget = provider;
    deleteOpen = true;
  }

  async function executeDelete() {
    if (!deleteTarget || !onDelete) return;
    deleting = true;
    await onDelete(deleteTarget.providerId);
    deleting = false;
    deleteOpen = false;
    deleteTarget = null;
  }
</script>

<div class="mt-6">
  <h3 class="text-sm font-semibold text-foreground">Configured providers</h3>
  {#if loading}
    <p class="mt-2 text-sm text-muted-foreground">Loading providers...</p>
  {:else if error}
    <p class="mt-2 text-sm text-destructive">{error.message}</p>
  {:else if providers.length}
    <div class="mt-3 space-y-3">
      {#each providers as provider}
        <Card.Root class="p-0">
          <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div>
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium text-foreground">
                  {provider.providerId}
                </p>
                {#if provider.providerId === highlightedProviderId}
                  <Badge variant="outline">New</Badge>
                {/if}
              </div>
              <p class="text-xs text-muted-foreground">
                {provider.type.toUpperCase()} &middot; {provider.domain}
              </p>
            </div>
            <div class="flex items-center gap-3">
              <div class="text-xs text-muted-foreground text-right">
                <div>{provider.issuer}</div>
                {#if provider.type === "saml" && provider.samlConfig?.entryPoint}
                  <div class="text-[11px] opacity-70">
                    Entry: {provider.samlConfig.entryPoint}
                  </div>
                {/if}
                {#if provider.type === "oidc" && provider.oidcConfig?.clientId}
                  <div class="text-[11px] opacity-70">
                    Client ID: {provider.oidcConfig.clientId}
                  </div>
                {/if}
              </div>
              {#if onDelete}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onclick={() => confirmDelete(provider)}
                >
                  <Trash2 class="w-4 h-4 text-muted-foreground hover:text-destructive" />
                </Button>
              {/if}
            </div>
          </div>
        </Card.Root>
      {/each}
    </div>
  {:else}
    <p class="mt-2 text-sm text-muted-foreground">
      No SSO providers have been added yet.
    </p>
  {/if}
</div>

<Modal bind:open={deleteOpen} onClose={() => { deleteOpen = false; deleteTarget = null; }}>
  <div class="bg-card rounded-xl border shadow-2xl max-w-md w-full p-6 space-y-4">
    <h2 class="text-lg font-semibold">Delete SSO provider</h2>
    {#if deleteTarget}
      <p class="text-sm text-muted-foreground">
        Are you sure you want to delete the <span class="font-medium text-foreground">{deleteTarget.type.toUpperCase()}</span> provider
        <span class="font-mono font-medium text-foreground">{deleteTarget.providerId}</span>?
      </p>
      <p class="text-sm text-muted-foreground">
        Users who sign in through this provider will no longer be able to authenticate via SSO. This action cannot be undone.
      </p>
    {/if}
    <div class="flex items-center justify-end gap-3 pt-2">
      <Button variant="outline" size="sm" onclick={() => { deleteOpen = false; deleteTarget = null; }}>
        Cancel
      </Button>
      <Button variant="destructive" size="sm" disabled={deleting} onclick={executeDelete}>
        {deleting ? "Deleting..." : "Delete provider"}
      </Button>
    </div>
  </div>
</Modal>
