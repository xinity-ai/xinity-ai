<svelte:head>
  <title>Access Methods | Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-5xl">
  <a href="/docs/" class="inline-flex items-center gap-1 mb-6 text-sm text-gray-500 hover:text-gray-700">
    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
    </svg>
    Back to Documentation
  </a>

  <h1 class="mb-2 text-4xl font-bold">Access Methods</h1>
  <p class="mb-8 text-lg text-gray-600">
    Xinity AI exposes two distinct APIs serving different purposes. Understanding which one you need is the
    starting point for any integration.
  </p>

  <!-- Two APIs overview -->
  <div class="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2">
    <div class="bg-white rounded-lg shadow-md p-5 border-t-4 border-xinity-purple">
      <h2 class="mb-1 text-lg font-semibold">Inference Gateway</h2>
      <p class="text-sm text-gray-600">
        The API your applications talk to. Accepts chat completion and embedding requests,
        routes them to the right model, and returns responses. Compatible with the OpenAI client SDK.
      </p>
      <p class="mt-3 text-xs text-gray-400 font-medium uppercase tracking-wide">Used by: applications, clients, SDKs</p>
    </div>
    <div class="bg-white rounded-lg shadow-md p-5 border-t-4 border-xinity-coral">
      <h2 class="mb-1 text-lg font-semibold">Dashboard Management</h2>
      <p class="text-sm text-gray-600">
        The API for administering the system. Manages deployments, organizations, API keys, recorded calls,
        users, SSO, and all other operational configuration.
      </p>
      <p class="mt-3 text-xs text-gray-400 font-medium uppercase tracking-wide">Used by: admins, operators, automation</p>
    </div>
  </div>

  <!-- SECTION: Inference Gateway -->
  <h2 class="mb-4 text-2xl font-bold text-gray-800">Inference Gateway</h2>

  <div class="mb-8 bg-white rounded-lg shadow-md p-6">
    <p class="mb-4 text-gray-600">
      The gateway listens on its own host and port (configured separately from the dashboard during deployment).
      It exposes an OpenAI-compatible API, so any application or library that works with OpenAI can point at
      the gateway URL instead with no other code changes.
    </p>

    <div class="mb-4 bg-xinity-purple/10 border-l-4 border-xinity-purple p-4 rounded-r-lg">
      <p class="text-sm font-medium text-xinity-pink">Authentication</p>
      <p class="mt-1 text-sm text-xinity-pink">
        Gateway API keys are created in this dashboard under
        <a href="/ai-api-keys/" class="font-semibold text-xinity-pink hover:underline">AI API Keys</a>
        and passed as a standard
        <code class="bg-xinity-purple/15 px-1 rounded">Authorization: Bearer</code> token in your requests.
        These are separate from dashboard API keys (found under Settings &rarr; API Keys), which are used
        for the management API.
      </p>
    </div>

    <p class="mb-2 text-sm font-medium text-gray-700">Available endpoints:</p>
    <ul class="mb-4 space-y-1 text-sm text-gray-600 list-disc list-inside">
      <li><code class="bg-gray-100 px-1 rounded">POST /v1/chat/completions</code> chat generation</li>
      <li><code class="bg-gray-100 px-1 rounded">POST /v1/completions</code> text completion</li>
      <li><code class="bg-gray-100 px-1 rounded">POST /v1/embeddings</code> text embeddings</li>
      <li><code class="bg-gray-100 px-1 rounded">POST /v1/rerank</code> reranking</li>
      <li><code class="bg-gray-100 px-1 rounded">POST /v1/responses</code> responses API</li>
      <li><code class="bg-gray-100 px-1 rounded">GET /v1/models</code> list available deployments</li>
    </ul>

    <pre class="bg-gray-900 text-gray-100 rounded-lg p-4 text-sm overflow-x-auto"><code>curl https://your-gateway/v1/chat/completions \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '&#123;"model": "my-model", "messages": [&#123;"role": "user", "content": "Hello"&#125;]&#125;'</code></pre>
  </div>

  <!-- SECTION: Dashboard Management -->
  <h2 class="mb-4 text-2xl font-bold text-gray-800">Dashboard Management</h2>
  <p class="mb-4 text-gray-600">
    All management operations (deployments, API keys, data, users, SSO configuration) are available through four
    different interfaces. All programmatic access authenticates with a dashboard API key from
    <strong>Settings &rarr; API Keys</strong>.
  </p>

  <!-- Dashboard UI -->
  <div class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h3 class="mb-1 text-xl font-semibold">Dashboard UI</h3>
    <p class="mb-4 text-gray-600">
      The web interface you are using right now. Covers day-to-day operations: managing deployments, API keys,
      applications, organizations, reviewing recorded LLM calls, and testing chat / embedding / rerank deployments
      directly from the Model Hub without writing any client code. No credentials or tooling required beyond a browser.
    </p>
    <p class="text-sm text-gray-500">Best for: visual exploration, one-off administrative tasks, reviewing call history, smoke-testing a freshly-deployed model.</p>
  </div>

  <!-- Management REST API -->
  <div class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h3 class="mb-1 text-xl font-semibold">Management REST API</h3>
    <p class="mb-4 text-gray-600">
      Every dashboard operation is available as a REST endpoint. The full API is documented live at
      <a href="/api/" class="text-xinity-magenta hover:underline"><code class="px-1 py-0.5 bg-gray-100 rounded text-sm">/api/</code></a>,
      with an OpenAPI schema at
      <a href="/api/openapi.json" class="text-xinity-magenta hover:underline"><code class="px-1 py-0.5 bg-gray-100 rounded text-sm">/api/openapi.json</code></a>
      for code generation or importing into tools like Postman.
    </p>

    <div class="mb-4 bg-xinity-purple/10 border-l-4 border-xinity-purple p-4 rounded-r-lg">
      <p class="text-sm font-medium text-xinity-pink">Authentication</p>
      <p class="mt-1 text-sm text-xinity-pink">
        Pass your dashboard API key in the <code class="bg-xinity-purple/15 px-1 rounded">x-api-key</code> header on every request.
      </p>
    </div>

    <pre class="bg-gray-900 text-gray-100 rounded-lg p-4 text-sm overflow-x-auto"><code>curl -H "x-api-key: sk_..." https://your-dashboard/api/deployment</code></pre>

    <p class="mt-3 text-sm text-gray-500">Best for: scripting, CI/CD pipelines, custom integrations, generated SDK clients.</p>
  </div>

  <!-- MCP Server -->
  <div class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h3 class="mb-1 text-xl font-semibold">MCP Server</h3>
    <p class="mb-4 text-gray-600">
      The dashboard exposes a <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener" class="text-xinity-magenta hover:underline">Model Context Protocol</a>
      endpoint at <code class="px-1 py-0.5 bg-gray-100 rounded text-sm">/mcp</code>. AI assistants such as Claude Desktop and Cursor
      can connect to it and manage the system using natural language. All non-restricted management operations are available
      as MCP tools and stay in sync with the management API automatically.
    </p>

    <div class="mb-4 bg-xinity-purple/10 border-l-4 border-xinity-purple p-4 rounded-r-lg">
      <p class="text-sm font-medium text-xinity-pink">Authentication</p>
      <p class="mt-1 text-sm text-xinity-pink">
        Pass your dashboard API key as a bearer token or via the
        <code class="bg-xinity-purple/15 px-1 rounded">x-api-key</code> header. Both are equivalent.
      </p>
    </div>

    <p class="mb-2 text-sm font-medium text-gray-700">Claude Code (CLI):</p>
    <pre class="bg-gray-900 text-gray-100 rounded-lg p-4 text-sm overflow-x-auto mb-4"><code>claude mcp add --transport http xinity https://your-dashboard/mcp \
  --header "Authorization: Bearer sk_..."</code></pre>

    <p class="mb-2 text-sm font-medium text-gray-700">Claude Desktop / Windsurf:</p>
    <p class="mb-2 text-sm text-gray-600">
      Add the following to your configuration file
      (<code class="px-1 py-0.5 bg-gray-100 rounded text-sm">claude_desktop_config.json</code> for Claude Desktop,
      <code class="px-1 py-0.5 bg-gray-100 rounded text-sm">~/.codeium/windsurf/mcp_config.json</code> for Windsurf):
    </p>
    <pre class="bg-gray-900 text-gray-100 rounded-lg p-4 text-sm overflow-x-auto mb-4"><code>&#123;
  "mcpServers": &#123;
    "xinity-ai": &#123;
      "url": "https://your-dashboard/mcp",
      "headers": &#123; "Authorization": "Bearer sk_..." &#125;
    &#125;
  &#125;
&#125;</code></pre>

    <p class="mb-2 text-sm font-medium text-gray-700">Cursor:</p>
    <p class="mb-2 text-sm text-gray-600">
      Add to <code class="px-1 py-0.5 bg-gray-100 rounded text-sm">.cursor/mcp.json</code> in your project or
      <code class="px-1 py-0.5 bg-gray-100 rounded text-sm">~/.cursor/mcp.json</code> globally:
    </p>
    <pre class="bg-gray-900 text-gray-100 rounded-lg p-4 text-sm overflow-x-auto mb-4"><code>&#123;
  "mcpServers": &#123;
    "xinity-ai": &#123;
      "url": "https://your-dashboard/mcp",
      "headers": &#123; "Authorization": "Bearer sk_..." &#125;
    &#125;
  &#125;
&#125;</code></pre>

    <p class="mb-2 text-sm text-gray-600">
      All clients also accept the <code class="px-1 py-0.5 bg-gray-100 rounded text-sm">x-api-key</code> header as an alternative:
    </p>
    <pre class="bg-gray-900 text-gray-100 rounded-lg p-4 text-sm overflow-x-auto mb-4"><code>&#123; "headers": &#123; "x-api-key": "sk_..." &#125; &#125;</code></pre>

    <div class="mb-4 bg-xinity-purple/10 border-l-4 border-xinity-purple p-4 rounded-r-lg">
      <p class="text-sm font-medium text-xinity-pink">Restricted operations</p>
      <p class="mt-1 text-sm text-xinity-pink">
        Certain management operations are intentionally unavailable via MCP: credential management (passwords, passkeys,
        API keys), SSO provider configuration, organization deletion, onboarding flows, and all instance-admin operations.
        These require explicit human action through the dashboard UI or REST API.
        The MCP endpoint can also be disabled entirely by the operator via <code class="bg-xinity-purple/15 px-1 rounded">MCP_ENABLED=false</code>.
      </p>
    </div>

    <p class="text-sm text-gray-500">Best for: natural-language management of deployments, applications, and API keys via AI assistants.</p>
  </div>

  <!-- Xinity CLI -->
  <div class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h3 class="mb-1 text-xl font-semibold">Xinity CLI</h3>
    <p class="mb-4 text-gray-600">
      The CLI is the primary tool for installing, configuring, and managing Xinity services. It also provides
      commands for day-to-day administrative tasks without opening the dashboard.
    </p>

    <p class="mb-2 text-sm font-medium text-gray-700">Install:</p>
    <pre class="bg-gray-900 text-gray-100 rounded-lg p-4 text-sm overflow-x-auto mb-4"><code>curl -fsSL https://github.com/xinity-ai/xinity-ai/releases/latest/download/install.sh | bash</code></pre>

    <p class="mb-1 text-sm text-gray-600">
      The installer downloads the latest release binary for your platform, verifies its checksum, and places it
      in <code class="bg-gray-100 px-1 rounded">~/.local/bin</code>. You can pin a version with
      <code class="bg-gray-100 px-1 rounded">--version v1.0.0</code> or change the directory with
      <code class="bg-gray-100 px-1 rounded">--prefix /usr/local/bin</code>.
    </p>

    <p class="mt-4 mb-2 text-sm font-medium text-gray-700">Key commands:</p>
    <pre class="bg-gray-900 text-gray-100 rounded-lg p-4 text-sm overflow-x-auto mb-4"><code>xinity up all            # install and configure services
xinity doctor            # check system health
xinity act --help        # call dashboard API routes from the terminal
xinity update            # update the CLI itself</code></pre>

    <p class="mt-3 text-sm text-gray-500">Best for: server-side automation, headless environments, installation and configuration.</p>
  </div>

  <!-- Related links -->
  <div class="bg-linear-to-r from-xinity-purple/10 to-xinity-coral/10 rounded-lg p-6">
    <h3 class="mb-3 text-lg font-semibold text-gray-800">Related</h3>
    <div class="grid grid-cols-1 gap-2 md:grid-cols-3">
      <a href="/docs/api-reference/" class="flex items-center gap-2 text-sm text-xinity-magenta hover:text-xinity-pink hover:underline">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        API Reference
      </a>
      <a href="/settings/auth/" class="flex items-center gap-2 text-sm text-xinity-magenta hover:text-xinity-pink hover:underline">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
        </svg>
        Manage API Keys
      </a>
      <a href="/docs/quick-start/" class="flex items-center gap-2 text-sm text-xinity-magenta hover:text-xinity-pink hover:underline">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        Quick Start Guide
      </a>
    </div>
  </div>
</div>
