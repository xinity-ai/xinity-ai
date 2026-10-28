<script lang="ts">
  import { ArrowLeft } from "@lucide/svelte";
  import { getClientEnv } from "$lib/clientEnv";
  import CodeExample from "$lib/components/CodeExample.svelte";
  import ModelPicker from "$lib/components/coding-agents/ModelPicker.svelte";
  import { createModelSelection } from "$lib/components/coding-agents/model-selection.svelte";
  import type { OrgModel } from "$lib/server/lib/models/org-models";
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();
  const { GATEWAY_URL } = getClientEnv();
  const apiBase = `${GATEWAY_URL}/v1`;

  const selection = createModelSelection(() => data.models);
  let titleModel = $state("");

  const effectiveTitleModel = $derived(selection.selected.includes(titleModel) ? titleModel : selection.primary);

  // Without an output limit OpenCode asks for 32k tokens, which a long reasoning phase can use up
  // before the answer starts. It shrinks each request to the room the prompt leaves on its own.
  function modelEntry(model: OrgModel) {
    return {
      name: model.name,
      capabilities: { tools: true, input: model.vision ? ["text", "image"] : ["text"], output: ["text"] },
      limit: { context: model.contextWindow, output: Math.floor(model.contextWindow / 4) },
    };
  }

  const configJson = $derived(JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    providers: {
      xinity: {
        name: "Xinity AI",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: apiBase },
        models: Object.fromEntries(selection.entries.map(m => [m.publicSpecifier, modelEntry(m)])),
      },
    },
    model: `xinity/${selection.primary}`,
    agents: { title: { model: `xinity/${effectiveTitleModel}` } },
  }, null, 2));
</script>

<svelte:head>
  <title>OpenCode - Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <nav class="mb-6">
    <a href="/docs/coding-agents/" class="text-xinity-magenta hover:text-xinity-pink flex items-center gap-2">
      <ArrowLeft class="w-4 h-4" />
      Coding Agents
    </a>
  </nav>

  <h1 class="mb-4 text-4xl font-bold">OpenCode</h1>
  <p class="mb-8 text-lg text-gray-600">
    Point <a href="https://opencode.ai" target="_blank" rel="noopener" class="text-xinity-magenta hover:text-xinity-pink">OpenCode</a>
    at your own deployments. The gateway speaks the OpenAI chat completions API, so OpenCode
    treats it as a custom provider.
  </p>

  <ModelPicker {selection}>
    <label class="block">
      <span class="block text-sm font-medium mb-1">Title generation model</span>
      <select
        value={effectiveTitleModel}
        onchange={e => (titleModel = e.currentTarget.value)}
        class="w-full border rounded px-3 py-2"
      >
        {#each selection.entries as model (model.publicSpecifier)}
          <option value={model.publicSpecifier}>{model.name}</option>
        {/each}
      </select>
      <span class="block text-sm text-gray-500 mt-1">
        Without this, OpenCode names sessions with a provider you have not configured.
        A small deployment is enough.
      </span>
    </label>
  </ModelPicker>

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">2. Write the config</h2>
    <p class="text-gray-600 mb-4">
      Save this as <code class="bg-gray-100 px-1 rounded">~/.config/opencode/opencode.json</code> to use it everywhere,
      or as <code class="bg-gray-100 px-1 rounded">opencode.json</code> in a project root to scope it to that project.
      OpenCode merges both.
    </p>
    <CodeExample code={configJson} language="json" withCopy />
  </section>

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">3. Authenticate</h2>
    <p class="text-gray-600 mb-4">
      Create a key on the <a href="/ai-api-keys/" class="text-xinity-magenta hover:text-xinity-pink">API keys</a> page,
      then hand it to OpenCode. It stores the key in its own credentials file, so nothing secret
      goes into the config you just wrote.
    </p>
    <CodeExample code={`opencode auth login xinity`} language="bash" withCopy />
    <p class="text-gray-600 mt-4">
      Paste the key (<code class="bg-gray-100 px-1 rounded">sk_...</code>) when asked.
      Start OpenCode and run <code class="bg-gray-100 px-1 rounded">/models</code> to confirm your models are listed.
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
