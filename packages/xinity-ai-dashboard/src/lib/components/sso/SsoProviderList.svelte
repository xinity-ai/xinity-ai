<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { copyToClipboard } from "$lib/copy";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Trash2, ShieldCheck, ShieldAlert, Copy, RefreshCw, Loader2 } from "@lucide/svelte";

  type ParsedProvider = {
    id: string;
    providerId: string;
    issuer: string;
    domain: string;
    domainVerified: boolean;
    type: "oidc" | "saml";
    oidcConfig: { clientId?: string | null } | null;
    samlConfig: { entryPoint?: string | null } | null;
    verification: { txtRecord: string; txtValue: string } | null;
  };

  let {
    providers = [],
    loading = false,
    error = null,
    highlightedProviderId = null,
    onDelete,
    onVerified,
  }: {
    providers?: ParsedProvider[];
    loading?: boolean;
    error?: Error | null;
    highlightedProviderId?: string | null;
    onDelete?: (providerId: string) => Promise<void>;
    onVerified?: () => void | Promise<void>;
  } = $props();

  let deleteTarget = $state<ParsedProvider | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state(false);

  let dnsCheckState = $state<Record<string, {
    verifying: boolean;
    verifyError?: string;
  }>>({});

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

  async function checkDns(providerId: string) {
    dnsCheckState[providerId] = { verifying: true };

    const { error } = await orpc.sso.verifyDomain({ providerId });
    if (error) {
      dnsCheckState[providerId] = { verifying: false, verifyError: error.message };
      return;
    }

    dnsCheckState[providerId] = { verifying: false };
    await onVerified?.();
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
      {#each providers as provider (provider.id)}
        {@const dns = dnsCheckState[provider.providerId]}
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
                {#if provider.domainVerified}
                  <Badge variant="outline" class="gap-1 text-emerald-600 border-emerald-600/30">
                    <ShieldCheck class="w-3 h-3" />
                    Verified
                  </Badge>
                {:else}
                  <Badge variant="outline" class="gap-1 text-amber-600 border-amber-600/30">
                    <ShieldAlert class="w-3 h-3" />
                    Unverified
                  </Badge>
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

          {#if !provider.domainVerified && provider.verification}
            <div class="border-t px-4 py-3">
              <Collapsible.Root>
                <Collapsible.Trigger>
                  {#snippet child({ props })}
                    <Button
                      {...props}
                      variant="ghost"
                      size="sm"
                      type="button"
                      class="text-xs"
                    >
                      Domain verification
                    </Button>
                  {/snippet}
                </Collapsible.Trigger>

                <Collapsible.Content>
                  <div class="mt-2 space-y-3">
                    <p class="text-xs text-muted-foreground">
                      Add the following TXT record to your DNS configuration, then click "Check DNS".
                    </p>
                    <div class="rounded-md border bg-muted/50 p-3 space-y-2">
                      <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0">
                          <p class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Record name</p>
                          <p class="text-xs font-mono text-foreground break-all">{provider.verification.txtRecord}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onclick={() => copyToClipboard(provider.verification?.txtRecord ?? "")}
                        >
                          <Copy class="w-3 h-3" />
                        </Button>
                      </div>
                      <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0">
                          <p class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Record value</p>
                          <p class="text-xs font-mono text-foreground break-all">{provider.verification.txtValue}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onclick={() => copyToClipboard(provider.verification?.txtValue ?? "")}
                        >
                          <Copy class="w-3 h-3" />
                        </Button>
                      </div>
                      <p class="text-[11px] text-muted-foreground">Type: TXT</p>
                    </div>
                    <div class="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={dns?.verifying}
                        onclick={() => checkDns(provider.providerId)}
                      >
                        {#if dns?.verifying}
                          <Loader2 class="w-3 h-3 animate-spin" />
                          Checking...
                        {:else}
                          <RefreshCw class="w-3 h-3" />
                          Check DNS
                        {/if}
                      </Button>
                    </div>
                    {#if dns?.verifyError}
                      <p class="text-xs text-destructive">{dns.verifyError}</p>
                    {/if}
                  </div>
                </Collapsible.Content>
              </Collapsible.Root>
            </div>
          {/if}
        </Card.Root>
      {/each}
    </div>
  {:else}
    <p class="mt-2 text-sm text-muted-foreground">
      No SSO providers have been added yet.
    </p>
  {/if}
</div>

<ConfirmDialog
  bind:open={deleteOpen}
  title="Delete SSO provider"
  confirmLabel={deleting ? "Deleting..." : "Delete provider"}
  onConfirm={() => void executeDelete()}
  onCancel={() => { deleteOpen = false; deleteTarget = null; }}
>
  {#if deleteTarget}
    <p class="text-sm text-muted-foreground">
      Are you sure you want to delete the <span class="font-medium text-foreground">{deleteTarget.type.toUpperCase()}</span> provider
      <span class="font-mono font-medium text-foreground">{deleteTarget.providerId}</span>?
    </p>
    <p class="text-sm text-muted-foreground">
      Users who sign in through this provider will no longer be able to authenticate via SSO. This action cannot be undone.
    </p>
  {/if}
</ConfirmDialog>
