<script lang="ts">
  import { ArrowLeft } from "@lucide/svelte";
  import { getClientEnv } from "$lib/clientEnv";
  import CodeExample from "$lib/components/CodeExample.svelte";
  import ModelPicker from "$lib/components/coding-agents/ModelPicker.svelte";
  import ApiKeyGenerator from "$lib/components/coding-agents/ApiKeyGenerator.svelte";
  import { createModelSelection } from "$lib/components/coding-agents/model-selection.svelte";
  import type { OrgModel } from "$lib/server/lib/models/org-models";
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();
  const { GATEWAY_URL } = getClientEnv();

  const selection = createModelSelection(() => data.models);

  // supports_vision is set either way because Goose otherwise guesses it from the model name.
  function modelEntry(model: OrgModel) {
    return {
      name: model.publicSpecifier,
      context_limit: model.contextWindow,
      supports_vision: model.vision,
    };
  }

  const providerJson = $derived(JSON.stringify({
    name: "xinity",
    engine: "openai",
    display_name: "Xinity AI",
    api_key_env: "XINITY_API_KEY",
    base_url: `${GATEWAY_URL}/v1/chat/completions`,
    models: selection.entries.map(modelEntry),
    // Goose otherwise lists every model the gateway serves, embedding models included
    dynamic_models: false,
    supports_streaming: true,
    requires_auth: true,
  }, null, 2));
</script>

<svelte:head>
  <title>Goose - Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <nav class="mb-6">
    <a href="/docs/coding-agents/" class="text-xinity-magenta hover:text-xinity-pink flex items-center gap-2">
      <ArrowLeft class="w-4 h-4" />
      Coding Agents
    </a>
  </nav>

  <h1 class="mb-4 text-4xl font-bold">Goose</h1>
  <p class="mb-2 text-lg text-gray-600">
    Point <a href="https://github.com/aaif-goose/goose" target="_blank" rel="noopener" class="text-xinity-magenta hover:text-xinity-pink">Goose</a>
    at your own deployments. The gateway speaks the OpenAI chat completions API, so Goose
    treats it as a custom provider. The CLI and the desktop app share their settings, so
    connecting one connects both.
  </p>
  <p class="mb-8 text-sm text-gray-500">Last tested with Goose 1.57.0.</p>

  <ModelPicker {selection} />

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">2. Write the config</h2>
    <p class="text-gray-600 mb-4">
      Save this as <code class="bg-gray-100 px-1 rounded">~/.config/goose/custom_providers/xinity.json</code>,
      or <code class="bg-gray-100 px-1 rounded">%APPDATA%\Block\goose\config\custom_providers\xinity.json</code>
      on Windows. It lists your models together with their context windows, so Goose compacts a
      session before it outgrows the deployment.
    </p>
    <CodeExample code={providerJson} language="json" withCopy />
  </section>

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">3. Authenticate</h2>
    <p class="text-gray-600 mb-4">
      Run <code class="bg-gray-100 px-1 rounded">goose configure</code>. After the telemetry question,
      choose to set up a provider manually and find Xinity AI in the provider list using the search. When Goose asks whether to set <code class="bg-gray-100 px-1 rounded">XINITY_API_KEY</code>,
      answer yes and paste this key. Goose keeps it in your
      system keychain, so nothing secret goes into the config you just wrote.
    </p>
    <ApiKeyGenerator harness="Goose" command={key => key} />
    <p class="text-gray-600 mt-4">
      Then choose <code class="bg-gray-100 px-1 rounded">{selection.primary}</code> as the model and start
      a session with <code class="bg-gray-100 px-1 rounded">goose session</code>.
    </p>
  </section>

  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <a href="/docs/api-reference/" class="block p-4 bg-white rounded-lg shadow hover:shadow-md transition">
      <h3 class="font-semibold text-xinity-purple mb-1">API Reference</h3>
      <p class="text-sm text-gray-600">Everything the gateway exposes</p>
    </a>
    <a href="/docs/code-examples/" class="block p-4 bg-white rounded-lg shadow hover:shadow-md transition">
      <h3 class="font-semibold text-xinity-purple mb-1">Code Examples</h3>
      <p class="text-sm text-gray-600">Call the same endpoints from your own code</p>
    </a>
  </div>
</div>

<style>
  code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }
</style>
