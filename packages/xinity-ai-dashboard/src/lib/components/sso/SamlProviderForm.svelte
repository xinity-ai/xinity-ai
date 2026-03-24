<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { orpc } from "$lib/orpc/orpc-client";

  let { organizationId, onCreated }: {
    organizationId?: string;
    onCreated: (providerId: string) => void | Promise<void>;
  } = $props();

  const samlCallbackPath = "/api/auth/sso/saml2/callback/{providerId}";
  const samlMetadataPath = "/api/auth/sso/saml2/sp/metadata?providerId={providerId}";

  let providerId = $state("");
  let issuer = $state("");
  let domain = $state("");
  let samlIdpMetadata = $state("");
  let samlEntryPoint = $state("");
  let samlCert = $state("");
  let samlAudience = $state("");
  let samlWantAssertionsSigned = $state(false);
  let samlSignatureAlgorithm = $state("");
  let samlDigestAlgorithm = $state("");
  let samlIdentifierFormat = $state("");
  let showAdvanced = $state(false);
  let metadataError = $state("");
  let formError = $state("");
  let submitting = $state(false);

  const filledSamlCallbackPath = $derived(samlCallbackPath.replace("{providerId}", providerId || "{providerId}"));
  const filledSamlMetadataPath = $derived(samlMetadataPath.replace("{providerId}", providerId || "{providerId}"));

  const canSubmit = $derived(
    providerId.trim().length > 0 &&
      issuer.trim().length > 0 &&
      domain.trim().length > 0 &&
      samlEntryPoint.trim().length > 0 &&
      samlCert.trim().length > 0 &&
      !submitting,
  );

  function extractMetadata() {
    metadataError = "";
    if (!samlIdpMetadata.trim()) {
      metadataError = "Paste IdP metadata XML to extract values.";
      return;
    }

    try {
      const parser = new DOMParser();
      const xml = parser.parseFromString(samlIdpMetadata, "application/xml");
      const parseError = xml.getElementsByTagName("parsererror")[0];
      if (parseError) {
        metadataError = "Unable to parse XML metadata.";
        return;
      }

      // Extract entityID from the top-level EntityDescriptor → issuer
      const entityDescriptor = xml.querySelector("EntityDescriptor") ||
        xml.getElementsByTagNameNS("urn:oasis:names:tc:SAML:2.0:metadata", "EntityDescriptor")[0];
      const entityID = entityDescriptor?.getAttribute("entityID") || "";

      const ssoService = xml.querySelector(
        "SingleSignOnService[Binding*='HTTP-Redirect']",
      ) as Element | null;
      const ssoLocation =
        ssoService?.getAttribute("Location") ||
        xml.querySelector("SingleSignOnService")?.getAttribute("Location") ||
        "";

      const certNode = xml.querySelector("X509Certificate");
      const certValue = certNode?.textContent?.trim() || "";

      if (entityID) {
        issuer = entityID;
      }
      if (ssoLocation) {
        samlEntryPoint = ssoLocation;
      }
      if (certValue) {
        samlCert = certValue;
      }

      const missing: string[] = [];
      if (!entityID) missing.push("issuer (entityID)");
      if (!ssoLocation) missing.push("entry point");
      if (!certValue) missing.push("certificate");
      if (missing.length) {
        metadataError =
          `Metadata parsed, but ${missing.join(" and ")} could not be extracted. Please fill manually.`;
      }
    } catch {
      metadataError = "Unable to parse XML metadata.";
    }
  }

  async function submit() {
    formError = "";
    submitting = true;

    const { error, data } = await orpc.sso.registerSaml({
      organizationId: organizationId || undefined,
      providerId,
      issuer,
      domain,
      samlConfig: {
        entryPoint: samlEntryPoint.trim(),
        cert: samlCert.trim(),
        callbackUrl: samlCallbackPath.replace(
          "{providerId}",
          providerId || "{providerId}",
        ),
        audience: samlAudience.trim() || undefined,
        idpMetadata: samlIdpMetadata.trim()
          ? { metadata: samlIdpMetadata.trim() }
          : undefined,
        spMetadata: {},
        wantAssertionsSigned: samlWantAssertionsSigned,
        signatureAlgorithm: samlSignatureAlgorithm.trim() || undefined,
        digestAlgorithm: samlDigestAlgorithm.trim() || undefined,
        identifierFormat: samlIdentifierFormat.trim() || undefined,
      },
    });

    submitting = false;

    if (error) {
      formError = error.message;
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
    samlIdpMetadata = "";
    samlEntryPoint = "";
    samlCert = "";
    samlAudience = "";
    samlWantAssertionsSigned = false;
    samlSignatureAlgorithm = "";
    samlDigestAlgorithm = "";
    samlIdentifierFormat = "";
    showAdvanced = false;
    metadataError = "";
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
      <Label for="saml-provider-id">Provider ID</Label>
      <Input
        id="saml-provider-id"
        bind:value={providerId}
        placeholder="acme-saml"
        required
      />
    </div>
    <div class="space-y-2">
      <Label for="saml-issuer">Issuer URL</Label>
      <Input
        id="saml-issuer"
        bind:value={issuer}
        placeholder="https://idp.example.com"
        required
      />
    </div>
  </div>

  <div class="space-y-2">
    <Label for="saml-domain">Email domain</Label>
    <Input
      id="saml-domain"
      bind:value={domain}
      placeholder="https://acme.com"
      required
    />
  </div>

  <div class="space-y-2">
    <Label for="saml-metadata">IdP metadata XML</Label>
    <textarea
      id="saml-metadata"
      bind:value={samlIdpMetadata}
      rows="6"
      placeholder="Paste IdP metadata XML here"
      class="flex w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    ></textarea>
    <div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <Button variant="ghost" size="sm" type="button" onclick={extractMetadata}>
        Extract from metadata
      </Button>
      <span>Paste metadata first, then auto-fill issuer, entry point, and certificate.</span>
    </div>
    {#if metadataError}
      <p class="text-xs text-amber-600 dark:text-amber-400">{metadataError}</p>
    {/if}
  </div>

  <div class="rounded-lg border bg-muted/50 p-4 text-xs text-muted-foreground">
    <p>
      Callback URL:
      <span class="font-mono text-foreground" title="Provider not registered yet, so this URL won't work until you save.">
        {samlCallbackPath.replace("{providerId}", providerId || "{providerId}")}
      </span>
    </p>
    <p class="mt-2">
      SP metadata:
      <span class="font-mono text-foreground" title="Provider not registered yet, so this URL won't work until you save.">
        {filledSamlMetadataPath}
      </span>
    </p>
  </div>

  <div class="grid gap-4 md:grid-cols-2">
    <div class="space-y-2">
      <Label for="saml-entry-point">Entry point</Label>
      <Input
        id="saml-entry-point"
        bind:value={samlEntryPoint}
        placeholder="https://idp.example.com/sso"
        required
      />
    </div>
    <div class="space-y-2">
      <Label for="saml-audience">Audience (optional)</Label>
      <Input
        id="saml-audience"
        bind:value={samlAudience}
        placeholder="https://xinity.ai/sso"
      />
    </div>
  </div>

  <div class="space-y-2">
    <Label for="saml-cert">X.509 certificate</Label>
    <textarea
      id="saml-cert"
      bind:value={samlCert}
      rows="4"
      placeholder="Paste the IdP certificate here"
      class="flex w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      required
    ></textarea>
  </div>

  <Button
    variant="ghost"
    size="sm"
    type="button"
    onclick={() => (showAdvanced = !showAdvanced)}
  >
    {showAdvanced ? "Hide advanced settings" : "Show advanced settings"}
  </Button>

  {#if showAdvanced}
    <div class="rounded-lg border bg-muted/50 p-4">
      <div class="grid gap-4 md:grid-cols-2">
        <div class="space-y-2">
          <Label for="saml-identifier-format">Identifier format</Label>
          <Input
            id="saml-identifier-format"
            bind:value={samlIdentifierFormat}
            placeholder="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
          />
        </div>
        <div class="space-y-2">
          <Label for="saml-signature-algorithm">Signature algorithm</Label>
          <Input
            id="saml-signature-algorithm"
            bind:value={samlSignatureAlgorithm}
            placeholder="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
          />
        </div>
        <div class="space-y-2">
          <Label for="saml-digest-algorithm">Digest algorithm</Label>
          <Input
            id="saml-digest-algorithm"
            bind:value={samlDigestAlgorithm}
            placeholder="http://www.w3.org/2001/04/xmlenc#sha256"
          />
        </div>
        <div class="flex items-center gap-3">
          <label class="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox bind:checked={samlWantAssertionsSigned} />
            Require signed assertions
          </label>
        </div>
      </div>
    </div>
  {/if}

  {#if formError}
    <p class="text-sm text-destructive">{formError}</p>
  {/if}

  <div class="flex items-center gap-3">
    <Button type="submit" disabled={!canSubmit}>
      {submitting ? "Registering..." : "Register SAML provider"}
    </Button>
    <p class="text-xs text-muted-foreground">
      We'll validate the SAML configuration on save.
    </p>
  </div>
</form>
