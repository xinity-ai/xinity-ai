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

  // modalities is set either way because Qwen Code otherwise guesses it from the model name.
  function modelEntry(model: OrgModel) {
    return {
      id: model.publicSpecifier,
      name: model.name,
      envKey: "XINITY_API_KEY",
      baseUrl: apiBase,
      generationConfig: {
        contextWindowSize: model.contextWindow,
        modalities: { image: model.vision },
      },
    };
  }

  const settingsJson = $derived(JSON.stringify({
    modelProviders: {
      openai: selection.entries.map(modelEntry),
    },
    security: { auth: { selectedType: "openai" } },
    model: { name: selection.primary },
  }, null, 2));
</script>

<svelte:head>
  <title>Qwen Code - Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <nav class="mb-6">
    <a href="/docs/coding-agents/" class="text-xinity-magenta hover:text-xinity-pink flex items-center gap-2">
      <ArrowLeft class="w-4 h-4" />
      Coding Agents
    </a>
  </nav>

  <h1 class="mb-4 text-4xl font-bold">Qwen Code</h1>
  <p class="mb-8 text-lg text-gray-600">
    Point <a href="https://github.com/QwenLM/qwen-code" target="_blank" rel="noopener" class="text-xinity-magenta hover:text-xinity-pink">Qwen Code</a>
    at your own deployments. The gateway speaks the OpenAI chat completions API, so Qwen Code
    treats it as an OpenAI compatible provider.
  </p>

  <ModelPicker {selection} />

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">2. Write the config</h2>
    <p class="text-gray-600 mb-4">
      Save this as <code class="bg-gray-100 px-1 rounded">~/.qwen/settings.json</code>. Merge it into the
      file if it already exists, since it holds your other Qwen Code settings too. It lists your
      models together with their context windows, so Qwen Code compresses a session before it
      outgrows the deployment, and makes your default model the one Qwen Code starts with.
    </p>
    <CodeExample code={settingsJson} language="json" withCopy />
  </section>

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">3. Authenticate</h2>
    <p class="text-gray-600 mb-4">
      Qwen Code reads the key from the <code class="bg-gray-100 px-1 rounded">XINITY_API_KEY</code> environment
      variable, so nothing secret goes into the config you just wrote. Add this line to your shell
      profile, such as <code class="bg-gray-100 px-1 rounded">~/.bashrc</code> or
      <code class="bg-gray-100 px-1 rounded">~/.zshrc</code>, and open a new terminal.
    </p>
    <ApiKeyGenerator harness="Qwen Code" command={key => `export XINITY_API_KEY=${key}`} />
    <p class="text-gray-600 mt-4">
      Start <code class="bg-gray-100 px-1 rounded">qwen</code> and run
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
