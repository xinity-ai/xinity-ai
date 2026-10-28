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
  const apiBase = `${GATEWAY_URL}/v1`;

  const selection = createModelSelection(() => data.models);

  function modelEntry(model: OrgModel) {
    return {
      id: model.publicSpecifier,
      name: model.name,
      ...(model.vision ? { input: ["text", "image"] } : {}),
      contextWindow: model.contextWindow,
    };
  }

  const modelsJson = $derived(JSON.stringify({
    "$schema": "https://pi.dev/schemas/models.schema.json",
    providers: {
      xinity: {
        name: "Xinity AI",
        baseUrl: apiBase,
        api: "openai-completions",
        apiKey: "$XINITY_API_KEY",
        models: selection.entries.map(modelEntry),
      },
    },
  }, null, 2));

  const settingsJson = $derived(JSON.stringify({
    defaultProvider: "xinity",
    defaultModel: selection.primary,
  }, null, 2));
</script>

<svelte:head>
  <title>Pi - Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <nav class="mb-6">
    <a href="/docs/coding-agents/" class="text-xinity-magenta hover:text-xinity-pink flex items-center gap-2">
      <ArrowLeft class="w-4 h-4" />
      Coding Agents
    </a>
  </nav>

  <h1 class="mb-4 text-4xl font-bold">Pi</h1>
  <p class="mb-8 text-lg text-gray-600">
    Point <a href="https://pi.dev" target="_blank" rel="noopener" class="text-xinity-magenta hover:text-xinity-pink">Pi</a>
    at your own deployments. The gateway speaks the OpenAI chat completions API, so Pi
    treats it as a custom provider.
  </p>

  <ModelPicker {selection} />

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">2. Write the config</h2>
    <p class="text-gray-600 mb-4">
      Save this as <code class="bg-gray-100 px-1 rounded">~/.pi/agent/models.json</code>.
      It lists your models together with their context windows, so Pi compacts a session before
      it outgrows the deployment.
    </p>
    <CodeExample code={modelsJson} language="json" withCopy />
    <p class="text-gray-600 mt-6 mb-4">
      To start Pi on your default model, add these keys to
      <code class="bg-gray-100 px-1 rounded">~/.pi/agent/settings.json</code>. Merge them into the file
      if it already exists, since it holds your other Pi settings too.
    </p>
    <CodeExample code={settingsJson} language="json" withCopy />
  </section>

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">3. Authenticate</h2>
    <p class="text-gray-600 mb-4">
      Pi reads the key from the <code class="bg-gray-100 px-1 rounded">XINITY_API_KEY</code> environment
      variable, so nothing secret goes into the config you just wrote. Add this line to your shell
      profile, such as <code class="bg-gray-100 px-1 rounded">~/.bashrc</code> or
      <code class="bg-gray-100 px-1 rounded">~/.zshrc</code>, and open a new terminal.
    </p>
    <ApiKeyGenerator harness="Pi" command={key => `export XINITY_API_KEY=${key}`} />
    <p class="text-gray-600 mt-4">
      Start <code class="bg-gray-100 px-1 rounded">pi</code> and run
      <code class="bg-gray-100 px-1 rounded">/model</code> to confirm your models are listed.
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
