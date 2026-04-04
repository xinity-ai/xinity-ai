<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { orpc } from "$lib/orpc/orpc-client";

  let { organizationId, onCreated }: {
    organizationId?: string;
    onCreated: (providerId: string) => void | Promise<void>;
  } = $props();

  const redirectPath = "/api/auth/sso/callback/{providerId}";

  let providerId = $state("");
  let issuer = $state("");
  let domain = $state("");
  let clientId = $state("");
  let clientSecret = $state("");
  let pkce = $state(true);
  let discoveryEndpoint = $state("");
  let tokenEndpointAuthentication = $state<string>("client_secret_basic");
  let authorizationEndpoint = $state("");
  let tokenEndpoint = $state("");
  let jwksEndpoint = $state("");
  let userInfoEndpoint = $state("");
  let showAdvanced = $state(false);
  let formError = $state("");
  let submitting = $state(false);

  const canSubmit = $derived(
    providerId.trim().length > 0 &&
      issuer.trim().length > 0 &&
      domain.trim().length > 0 &&
      clientId.trim().length > 0 &&
      clientSecret.trim().length > 0 &&
      !submitting,
  );

  async function submit() {
    formError = "";
    submitting = true;

    const { error, data } = await orpc.sso.registerOidc({
      organizationId: organizationId || undefined,
      providerId,
      issuer,
      domain,
      oidcConfig: {
        clientId,
        clientSecret,
        scopes: ["openid", "email", "profile"],
        pkce,
        discoveryEndpoint: discoveryEndpoint.trim() || undefined,
        tokenEndpointAuthentication: (tokenEndpointAuthentication as "client_secret_basic" | "client_secret_post") || undefined,
        authorizationEndpoint: authorizationEndpoint.trim() || undefined,
        tokenEndpoint: tokenEndpoint.trim() || undefined,
        jwksEndpoint: jwksEndpoint.trim() || undefined,
        userInfoEndpoint: userInfoEndpoint.trim() || undefined,
      },
    });

    submitting = false;

    if (error) {
      formError = error.message || "An unknown error occurred.";
      return;
    }

    if (data?.providerId) {
      await onCreated(data.providerId);
    }

    reset();
  }

  function reset() {
    providerId = "";
    issuer = "";
    domain = "";
    clientId = "";
    clientSecret = "";
    pkce = true;
    discoveryEndpoint = "";
    tokenEndpointAuthentication = "client_secret_basic";
    authorizationEndpoint = "";
    tokenEndpoint = "";
    jwksEndpoint = "";
    userInfoEndpoint = "";
    showAdvanced = false;
  }
</script>

<form
  method="POST"
  onsubmit={(evt) => {
    evt.preventDefault();
    submit();
  }}
  class="mt-4 space-y-4"
>
  <div class="grid gap-4 md:grid-cols-2">
    <div class="space-y-2">
      <Label for="oidc-provider-id">Provider ID</Label>
      <Input
        id="oidc-provider-id"
        bind:value={providerId}
        placeholder="acme-oidc"
        required
      />
      <p class="text-xs text-muted-foreground">
        Callback: <span class="font-mono">{redirectPath.replace("{providerId}", providerId || "{providerId}")}</span>
      </p>
    </div>

    <div class="space-y-2">
      <Label for="oidc-issuer">Issuer URL</Label>
      <Input
        id="oidc-issuer"
        bind:value={issuer}
        placeholder="https://idp.example.com"
        required
      />
    </div>
  </div>

  <div class="space-y-2">
    <Label for="oidc-domain">Email domain</Label>
    <Input
      id="oidc-domain"
      bind:value={domain}
      placeholder="https://acme.com"
      required
    />
  </div>

  <div class="grid gap-4 md:grid-cols-2">
    <div class="space-y-2">
      <Label for="oidc-client-id">Client ID</Label>
      <Input
        id="oidc-client-id"
        bind:value={clientId}
        required
      />
    </div>
    <div class="space-y-2">
      <Label for="oidc-client-secret">Client Secret</Label>
      <Input
        id="oidc-client-secret"
        type="password"
        bind:value={clientSecret}
        required
      />
    </div>
  </div>

  <div class="flex items-center gap-3 text-sm text-muted-foreground">
    <label class="inline-flex items-center gap-2">
      <Checkbox bind:checked={pkce} />
      Use PKCE
    </label>
    <span class="text-xs">Scopes: openid email profile</span>
  </div>

  <Collapsible.Root bind:open={showAdvanced}>
    <Collapsible.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="sm"
          type="button"
        >
          {showAdvanced ? "Hide advanced settings" : "Show advanced settings"}
        </Button>
      {/snippet}
    </Collapsible.Trigger>

    <Collapsible.Content>
      <div class="rounded-lg border bg-muted/50 p-4">
        <p class="text-xs text-muted-foreground">
          OIDC discovery fills most endpoint fields automatically. Use these only
          when required by your IdP.
        </p>
        <div class="mt-3 grid gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <Label for="oidc-discovery-endpoint">Discovery endpoint</Label>
            <Input
              id="oidc-discovery-endpoint"
              bind:value={discoveryEndpoint}
              placeholder="https://idp.example.com/.well-known/openid-configuration"
            />
          </div>
          <div class="space-y-2">
            <Label for="oidc-token-endpoint-auth">Token endpoint auth</Label>
            <Select.Root type="single" bind:value={tokenEndpointAuthentication}>
              <Select.Trigger class="w-full">
                {tokenEndpointAuthentication}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="client_secret_basic" label="client_secret_basic" />
                <Select.Item value="client_secret_post" label="client_secret_post" />
              </Select.Content>
            </Select.Root>
          </div>
        </div>
        <div class="mt-4 grid gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <Label for="oidc-authorization-endpoint">Authorization endpoint</Label>
            <Input
              id="oidc-authorization-endpoint"
              bind:value={authorizationEndpoint}
              placeholder="https://idp.example.com/authorize"
            />
          </div>
          <div class="space-y-2">
            <Label for="oidc-token-endpoint">Token endpoint</Label>
            <Input
              id="oidc-token-endpoint"
              bind:value={tokenEndpoint}
              placeholder="https://idp.example.com/token"
            />
          </div>
          <div class="space-y-2">
            <Label for="oidc-jwks-endpoint">JWKS endpoint</Label>
            <Input
              id="oidc-jwks-endpoint"
              bind:value={jwksEndpoint}
              placeholder="https://idp.example.com/jwks"
            />
          </div>
          <div class="space-y-2">
            <Label for="oidc-userinfo-endpoint">UserInfo endpoint</Label>
            <Input
              id="oidc-userinfo-endpoint"
              bind:value={userInfoEndpoint}
              placeholder="https://idp.example.com/userinfo"
            />
          </div>
        </div>
      </div>
    </Collapsible.Content>
  </Collapsible.Root>

  {#if formError}
    <p class="text-sm text-destructive">{formError}</p>
  {/if}

  <div class="flex items-center gap-3">
    <Button type="submit" disabled={!canSubmit}>
      {submitting ? "Registering..." : "Register OIDC provider"}
    </Button>
    <p class="text-xs text-muted-foreground">
      We'll verify the issuer's discovery document on save.
    </p>
  </div>
</form>
