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
      name: model.name,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.vision ? { supportsVision: true } : {}),
    };
  }

  // Cline replaces a model's capabilities wholesale once it lists any, so streaming and tools
  // are declared once on the provider and each model only adds vision on top.
  const modelsJson = $derived(JSON.stringify({
    version: 1,
    providers: {
      xinity: {
        provider: {
          name: "Xinity AI",
          baseUrl: apiBase,
          defaultModelId: selection.primary,
          capabilities: ["streaming", "tools"],
        },
        models: Object.fromEntries(selection.entries.map(m => [m.publicSpecifier, modelEntry(m)])),
      },
    },
  }, null, 2));
</script>

<svelte:head>
  <title>Cline - Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <nav class="mb-6">
    <a href="/docs/coding-agents/" class="text-xinity-magenta hover:text-xinity-pink flex items-center gap-2">
      <ArrowLeft class="w-4 h-4" />
      Coding Agents
    </a>
  </nav>

  <h1 class="mb-4 text-4xl font-bold">Cline</h1>
  <p class="mb-8 text-lg text-gray-600">
    Point <a href="https://cline.bot" target="_blank" rel="noopener" class="text-xinity-magenta hover:text-xinity-pink">Cline</a>
    at your own deployments. The gateway speaks the OpenAI chat completions API, so Cline
    treats it as a custom provider. The CLI and the editor extension share their settings, so
    connecting one connects both.
  </p>

  <ModelPicker {selection} />

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">2. Write the config</h2>
    <p class="text-gray-600 mb-4">
      Save this as <code class="bg-gray-100 px-1 rounded">~/.cline/data/settings/models.json</code>.
      It lists your models together with their context windows, so Cline knows how much each
      deployment can take. If the file already exists, add the
      <code class="bg-gray-100 px-1 rounded">xinity</code> entry to its
      <code class="bg-gray-100 px-1 rounded">providers</code> instead of replacing it.
    </p>
    <CodeExample code={modelsJson} language="json" withCopy />
  </section>

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">3. Authenticate</h2>
    <p class="text-gray-600 mb-4">
      Run <code class="bg-gray-100 px-1 rounded">cline auth</code>, choose to bring your own provider,
      pick Xinity AI and paste this key when asked. Cline stores it in its own credentials file,
      so nothing secret goes into the config you just wrote.
    </p>
    <ApiKeyGenerator harness="Cline" command={key => key} />
    <p class="text-gray-600 mt-4">
      Start <code class="bg-gray-100 px-1 rounded">cline</code> and run
      <code class="bg-gray-100 px-1 rounded">/model</code> to confirm your models are listed, or reload
      your editor to use them in the extension.
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
