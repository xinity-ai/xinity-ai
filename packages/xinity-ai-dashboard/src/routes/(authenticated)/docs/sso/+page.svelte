<script lang="ts">
  const samlEnabled = false;
</script>

<svelte:head>
  <title>SSO Configuration - Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <nav class="mb-6">
    <a
      href="/docs/"
      class="text-blue-600 hover:text-blue-800 flex items-center gap-2"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4"
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z"
          clip-rule="evenodd"
        />
      </svg>
      All Docs
    </a>
  </nav>

  <h1 class="mb-4 text-4xl font-bold">Single Sign-On (SSO)</h1>
  <p class="mb-8 text-lg text-gray-600">
    Configure {samlEnabled ? "OIDC or SAML" : "OIDC"} identity providers for your organization or instance
  </p>

  <!-- Overview -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Overview</h2>
    <p class="text-gray-600 mb-4">
      Xinity AI supports Single Sign-On via <strong>OpenID Connect (OIDC)</strong>{#if samlEnabled} and <strong>SAML 2.0</strong>{/if}.
      SSO providers can be registered at two levels:
    </p>
    <ul class="list-disc pl-6 space-y-2 text-gray-600">
      <li>
        <strong>Organization-scoped</strong>, configured by organization admins under the organization settings.
        Only members of that organization can use the provider.
      </li>
      <li>
        <strong>Instance-wide</strong>, configured by instance admins under
        <a href="/instance-settings" class="text-blue-600 hover:text-blue-800 underline">Instance Settings</a>.
        These providers appear on the login page for all users.
      </li>
    </ul>
  </section>

  <!-- How users sign in -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">How Users Sign In with SSO</h2>
    <p class="text-gray-600 mb-4">
      Once a provider is registered, users sign in by navigating to:
    </p>
    <code class="block rounded-md bg-gray-100 px-4 py-3 text-sm font-mono mb-4">
      /login/sso/&lt;provider-id&gt;
    </code>
    <p class="text-gray-600">
      Replace <code class="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-sm">&lt;provider-id&gt;</code> with
      the ID you chose when registering the provider (e.g.
      <code class="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-sm">/login/sso/acme-oidc</code>).
      In single-tenant mode, instance-wide SSO providers also appear as buttons on the main login page automatically.
    </p>
  </section>

  <!-- OIDC Setup -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">OIDC Setup</h2>
    <p class="text-gray-600 mb-4">
      OpenID Connect is the simpler of the two protocols. In your Identity Provider (IdP), create an application and then register it in Xinity.
    </p>

    <div class="space-y-4">
      <div class="flex items-start gap-3">
        <div class="shrink-0 w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">1</div>
        <div>
          <h3 class="font-semibold mb-1">Create an application in your IdP</h3>
          <p class="text-gray-600 text-sm">
            Set the <strong>redirect URI</strong> to:
          </p>
          <code class="block mt-2 rounded-md bg-gray-100 px-3 py-2 text-xs font-mono">
            /api/auth/sso/callback/&lt;provider-id&gt;
          </code>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <div class="shrink-0 w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">2</div>
        <div>
          <h3 class="font-semibold mb-1">Copy credentials from your IdP</h3>
          <p class="text-gray-600 text-sm">
            You will need the <strong>client ID</strong> and <strong>client secret</strong>.
          </p>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <div class="shrink-0 w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">3</div>
        <div>
          <h3 class="font-semibold mb-1">Register the provider in Xinity</h3>
          <p class="text-gray-600 text-sm">
            Navigate to SSO settings and fill in the registration form with:
          </p>
          <ul class="list-disc pl-5 mt-2 text-gray-600 text-sm space-y-1">
            <li><strong>Provider ID</strong>, a short identifier (e.g. <code class="font-mono bg-gray-100 px-1 py-0.5 rounded text-xs">acme-oidc</code>)</li>
            <li><strong>Issuer URL</strong>, your IdP's issuer (without trailing slash). If your IdP supports OIDC discovery, all other endpoints are resolved automatically.</li>
            <li><strong>Email domain</strong>, the domain of users who should use this provider</li>
            <li><strong>Client ID</strong> and <strong>Client Secret</strong>, from step 2</li>
          </ul>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <div class="shrink-0 w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">4</div>
        <div>
          <h3 class="font-semibold mb-1">Test the connection</h3>
          <p class="text-gray-600 text-sm">
            Visit <code class="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-xs">/login/sso/&lt;provider-id&gt;</code> to verify sign-in works.
          </p>
        </div>
      </div>
    </div>

    <div class="mt-6 rounded-lg border bg-blue-50 p-4">
      <p class="text-sm text-blue-800">
        <strong>PKCE</strong> is enabled by default for added security. If your IdP doesn't support PKCE, you can disable it in the advanced settings during registration.
      </p>
    </div>
  </section>

  {#if samlEnabled}
  <!-- SAML Setup -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">SAML 2.0 Setup</h2>
    <p class="text-gray-600 mb-4">
      SAML requires a trust relationship between your Identity Provider (IdP) and Xinity as the Service Provider (SP).
    </p>

    <div class="space-y-4">
      <div class="flex items-start gap-3">
        <div class="shrink-0 w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">1</div>
        <div>
          <h3 class="font-semibold mb-1">Register the provider in Xinity</h3>
          <p class="text-gray-600 text-sm">
            If your IdP provides a metadata XML, paste it into the registration form and click "Extract from metadata"
            to auto-fill the issuer, entry point, and certificate. Otherwise, fill these fields manually:
          </p>
          <ul class="list-disc pl-5 mt-2 text-gray-600 text-sm space-y-1">
            <li><strong>Provider ID</strong>, a short identifier (e.g. <code class="font-mono bg-gray-100 px-1 py-0.5 rounded text-xs">acme-saml</code>)</li>
            <li><strong>Issuer URL</strong>, the entityID from your IdP's metadata</li>
            <li><strong>Email domain</strong>, the domain of users who should use this provider</li>
            <li><strong>Entry point</strong>, the IdP's SingleSignOnService URL (HTTP-Redirect binding)</li>
            <li><strong>X.509 certificate</strong>, the IdP's signing certificate</li>
          </ul>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <div class="shrink-0 w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">2</div>
        <div>
          <h3 class="font-semibold mb-1">Configure your IdP with Xinity's SP metadata</h3>
          <p class="text-gray-600 text-sm">
            After registering, Xinity exposes SP metadata at:
          </p>
          <code class="block mt-2 rounded-md bg-gray-100 px-3 py-2 text-xs font-mono">
            /api/auth/sso/saml2/sp/metadata?providerId=&lt;provider-id&gt;
          </code>
          <p class="text-gray-600 text-sm mt-2">
            Import this URL or its contents into your IdP as the Service Provider metadata.
          </p>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <div class="shrink-0 w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">3</div>
        <div>
          <h3 class="font-semibold mb-1">Set the Assertion Consumer Service (ACS) URL</h3>
          <p class="text-gray-600 text-sm">
            In your IdP, set the ACS / callback URL to:
          </p>
          <code class="block mt-2 rounded-md bg-gray-100 px-3 py-2 text-xs font-mono">
            /api/auth/sso/saml2/callback/&lt;provider-id&gt;
          </code>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <div class="shrink-0 w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">4</div>
        <div>
          <h3 class="font-semibold mb-1">Ensure email is sent as a claim</h3>
          <p class="text-gray-600 text-sm">
            Configure your IdP to release the user's <strong>email address</strong> as an attribute or NameID.
            Without it, authentication will fail with a <code class="font-mono bg-gray-100 px-1 py-0.5 rounded text-xs">missing_user_info</code> error.
          </p>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <div class="shrink-0 w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">5</div>
        <div>
          <h3 class="font-semibold mb-1">Test the connection</h3>
          <p class="text-gray-600 text-sm">
            Visit <code class="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-xs">/login/sso/&lt;provider-id&gt;</code> to verify sign-in works.
          </p>
        </div>
      </div>
    </div>
  </section>
  {/if}

  <!-- Troubleshooting -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 id="troubleshooting" class="text-2xl font-semibold mb-4">Troubleshooting</h2>
    <p class="text-gray-600 mb-6">
      When SSO sign-in fails, users are redirected to an error page with a specific error code.
    </p>

    <div class="space-y-4">
      <div class="rounded-lg border p-4">
        <div class="flex items-center gap-2 mb-2">
          <code class="text-xs font-mono bg-red-100 text-red-800 px-2 py-0.5 rounded">issuer_mismatch</code>
          <span class="text-xs font-medium text-red-600">Common</span>
        </div>
        <p class="text-sm text-gray-600 mb-1"><strong>Cause:</strong> The issuer URL in your SSO configuration doesn't match what the identity provider returns.</p>
        <p class="text-sm text-gray-600"><strong>Fix:</strong> Remove any trailing slash from the issuer URL. For example, use <code class="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">https://accounts.google.com</code> instead of <code class="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">https://accounts.google.com/</code>.</p>
      </div>

      <div class="rounded-lg border p-4">
        <div class="flex items-center gap-2 mb-2">
          <code class="text-xs font-mono bg-red-100 text-red-800 px-2 py-0.5 rounded">missing_user_info</code>
          <span class="text-xs font-medium text-red-600">Common</span>
        </div>
        <p class="text-sm text-gray-600 mb-1"><strong>Cause:</strong> The identity provider did not include an email address in its response.</p>
        <p class="text-sm text-gray-600"><strong>Fix:</strong> Configure your IdP to release the user's email address as a claim{#if samlEnabled} (OIDC) or attribute (SAML){/if}. The email claim is required for authentication.</p>
      </div>

      <div class="rounded-lg border p-4">
        <div class="flex items-center gap-2 mb-2">
          <code class="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded">provider_not_found</code>
        </div>
        <p class="text-sm text-gray-600 mb-1"><strong>Cause:</strong> No registered SSO provider matches the request.</p>
        <p class="text-sm text-gray-600"><strong>Fix:</strong> Verify the provider ID is correct and matches the registered configuration.</p>
      </div>

      <div class="rounded-lg border p-4">
        <div class="flex items-center gap-2 mb-2">
          <code class="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded">token_not_verified</code>
        </div>
        <p class="text-sm text-gray-600 mb-1"><strong>Cause:</strong> The identity token's signature could not be verified.</p>
        <p class="text-sm text-gray-600"><strong>Fix:</strong> The IdP's signing keys may have rotated, try again shortly.{#if samlEnabled} For SAML: verify the X.509 certificate is correct and up to date.{/if}</p>
      </div>

      {#if samlEnabled}
      <div class="rounded-lg border p-4">
        <div class="flex items-center gap-2 mb-2">
          <code class="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded">invalid_saml_response</code>
        </div>
        <p class="text-sm text-gray-600 mb-1"><strong>Cause:</strong> The SAML response could not be parsed or validated.</p>
        <p class="text-sm text-gray-600"><strong>Fix:</strong> Verify the X.509 certificate, entry point URL, and issuer. If using signed assertions, confirm the signature algorithm matches the IdP's configuration.</p>
      </div>
      {/if}

      <div class="rounded-lg border p-4">
        <div class="flex items-center gap-2 mb-2">
          <code class="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded">invalid_state</code>
        </div>
        <p class="text-sm text-gray-600 mb-1"><strong>Cause:</strong> The sign-in took too long or the browser's back button was used.</p>
        <p class="text-sm text-gray-600"><strong>Fix:</strong> Return to the login page and try signing in again.</p>
      </div>
    </div>
  </section>

  <!-- General Tips -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">General Tips</h2>
    <ul class="list-disc pl-6 space-y-2 text-gray-600">
      <li>Double-check that the <strong>issuer URL</strong> exactly matches what your IdP uses, no trailing slash.</li>
      <li>Ensure your IdP is configured to send the user's <strong>email address</strong> in the token claims{#if samlEnabled} or SAML assertions{/if}.</li>
      <li>Verify the <strong>client ID</strong> and <strong>client secret</strong> are correct.</li>
      {#if samlEnabled}
      <li>For SAML, verify the <strong>X.509 certificate</strong> and <strong>entry point URL</strong>.</li>
      {/if}
      <li>The <strong>callback URL</strong> shown in the registration form must be added to your IdP as an allowed redirect URI.</li>
      <li>SSO providers configured at the instance level appear as buttons on the login page automatically in single-tenant mode.</li>
    </ul>
  </section>
</div>
