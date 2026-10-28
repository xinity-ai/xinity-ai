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
  let smallModel = $state("");

  const effectiveSmallModel = $derived(selection.selected.includes(smallModel) ? smallModel : selection.primary);

  function quote(value: string) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
  }

  // Without an output limit a long reasoning phase can use up the request before the answer starts.
  function modelAdd(model: OrgModel) {
    return [
      `model add xinity/${model.publicSpecifier}`,
      `  --name ${quote(model.name)}`,
      `  --context-window ${model.contextWindow}`,
      `  --default-max-tokens ${Math.floor(model.contextWindow / 4)}`,
      ...(model.vision ? ["  --supports-images true"] : []),
    ].join(" \\\n");
  }

  const crushrc = $derived([
    [
      "provider add xinity",
      "  --name 'Xinity AI'",
      "  --type openai-compat",
      `  --base-url ${quote(apiBase)}`,
      `  --api-key "\${XINITY_API_KEY:?set XINITY_API_KEY}"`,
    ].join(" \\\n"),
    ...selection.entries.map(modelAdd),
    `model large xinity/${selection.primary}\nmodel small xinity/${effectiveSmallModel}`,
  ].join("\n\n"));
</script>

<svelte:head>
  <title>Crush - Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <nav class="mb-6">
    <a href="/docs/coding-agents/" class="text-xinity-magenta hover:text-xinity-pink flex items-center gap-2">
      <ArrowLeft class="w-4 h-4" />
      Coding Agents
    </a>
  </nav>

  <h1 class="mb-4 text-4xl font-bold">Crush</h1>
  <p class="mb-8 text-lg text-gray-600">
    Point <a href="https://github.com/charmbracelet/crush" target="_blank" rel="noopener" class="text-xinity-magenta hover:text-xinity-pink">Crush</a>
    at your own deployments. The gateway speaks the OpenAI chat completions API, so Crush
    treats it as a custom provider.
  </p>

  <ModelPicker {selection}>
    <label class="block">
      <span class="block text-sm font-medium mb-1">Small model</span>
      <select
        value={effectiveSmallModel}
        onchange={e => (smallModel = e.currentTarget.value)}
        class="w-full border rounded px-3 py-2"
      >
        {#each selection.entries as model (model.publicSpecifier)}
          <option value={model.publicSpecifier}>{model.name}</option>
        {/each}
      </select>
      <span class="block text-sm text-gray-500 mt-1">
        Crush hands its lighter side tasks to this model. A small deployment is enough.
      </span>
    </label>
  </ModelPicker>

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">2. Write the config</h2>
    <p class="text-gray-600 mb-4">
      Add these lines to <code class="bg-gray-100 px-1 rounded">~/.config/crush/crushrc</code> to use them
      everywhere, or to a <code class="bg-gray-100 px-1 rounded">.crushrc</code> in a project root to scope
      them to that project. They register your models together with their context windows and
      make your default model the one Crush starts with.
    </p>
    <CodeExample code={crushrc} language="bash" withCopy />
  </section>

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">3. Authenticate</h2>
    <p class="text-gray-600 mb-4">
      Crush reads the key from the <code class="bg-gray-100 px-1 rounded">XINITY_API_KEY</code> environment
      variable, so nothing secret goes into the config you just wrote. Add this line to your shell
      profile, such as <code class="bg-gray-100 px-1 rounded">~/.bashrc</code> or
      <code class="bg-gray-100 px-1 rounded">~/.zshrc</code>, and open a new terminal.
    </p>
    <ApiKeyGenerator harness="Crush" command={key => `export XINITY_API_KEY=${key}`} />
    <p class="text-gray-600 mt-4">
      Start <code class="bg-gray-100 px-1 rounded">crush</code> and open the model list with
      <code class="bg-gray-100 px-1 rounded">ctrl+l</code> to confirm your models are listed.
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
