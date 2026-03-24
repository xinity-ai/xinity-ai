<script lang="ts">
  import type { OIDCConfig, SAMLConfig } from "@better-auth/sso";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import SsoProviderList from "./SsoProviderList.svelte";
  import OidcProviderForm from "./OidcProviderForm.svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import CircleQuestionMark from "@lucide/svelte/icons/circle-question-mark";

  type ProviderSummary = {
    id: string;
    providerId: string;
    issuer: string;
    domain: string;
    oidcConfig: string | null;
    samlConfig: string | null;
    userId: string;
    organizationId: string | null;
  };

  let { organizationId }: {
    organizationId?: string;
  } = $props();

  let highlightedProviderId = $state<string | null>(null);
  let providers = $state<ProviderSummary[]>([]);
  let loading = $state(true);
  let loadError = $state<Error | null>(null);
  const parsedProviders = $derived(
    providers.map((provider) => {
      const parsedOidc = safeJsonParse<OIDCConfig>(provider.oidcConfig);
      const parsedSaml = safeJsonParse<SAMLConfig>(provider.samlConfig);
      const type = parsedSaml ? "saml" : "oidc";
      return {
        ...provider,
        type,
        oidcConfig: parsedOidc,
        samlConfig: parsedSaml,
      } as const;
    }),
  );

  async function fetchProviders() {
    loading = true;
    loadError = null;
    const { data, error } = await orpc.sso.listProviders({
      organizationId: organizationId || undefined,
    });
    loading = false;
    if (error) {
      loadError = error;
      return;
    }
    providers = data ?? [];
  }

  // Fetch on mount
  $effect(() => {
    fetchProviders();
  });

  async function handleProviderCreated(providerId: string) {
    highlightedProviderId = providerId;
    await fetchProviders();
  }

  async function handleProviderDelete(providerId: string) {
    const { error } = await orpc.sso.delete({ providerId });
    if (error) {
      loadError = error;
      return;
    }
    await fetchProviders();
  }

  function safeJsonParse<T>(value: string | null) {
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
</script>

<Card.Root>
  <Card.Header>
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <Card.Title>Single Sign-On (SSO)</Card.Title>
        <Card.Description>
          {#if organizationId}
            Configure your organization's SSO providers via OIDC.
          {:else}
            Configure instance-wide SSO providers. These apply to all users signing in.
          {/if}
        </Card.Description>
      </div>
      <Button variant="outline" size="sm" href="/docs/sso#troubleshooting">
        <CircleQuestionMark class="w-4 h-4 mr-1.5" />
        Troubleshooting
      </Button>
    </div>
  </Card.Header>

  <Card.Content>
    <SsoProviderList
      providers={parsedProviders}
      {loading}
      error={loadError}
      {highlightedProviderId}
      onDelete={handleProviderDelete}
    />

    <div class="mt-6 rounded-lg border p-6">
      <div>
        <h3 class="text-sm font-semibold text-foreground">Add a provider</h3>
        <p class="mt-1 text-xs text-muted-foreground">
          Configure an OIDC provider using the form below.
        </p>
      </div>

      <OidcProviderForm
        {organizationId}
        onCreated={handleProviderCreated}
      />

      <!-- {#if providerType === "oidc"}
        <OidcProviderForm
          {organizationId}
          onCreated={handleProviderCreated}
        />
      {:else}
        <SamlProviderForm
          {organizationId}
          onCreated={handleProviderCreated}
        />
      {/if} -->
    </div>
  </Card.Content>
</Card.Root>
