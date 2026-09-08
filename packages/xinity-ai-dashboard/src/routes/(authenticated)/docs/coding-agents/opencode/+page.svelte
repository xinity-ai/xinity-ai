<script lang="ts">
  import { ArrowLeft, Eye, CircleCheck } from "@lucide/svelte";
  import { getClientEnv } from "$lib/clientEnv";
  import CodeExample from "$lib/components/CodeExample.svelte";
  import type { OrgModel } from "$lib/server/org-models";
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();
  const { GATEWAY_URL } = getClientEnv();
  const apiBase = `${GATEWAY_URL}/v1`;

  const placeholder: OrgModel = {
    publicSpecifier: "your-deployment",
    name: "Your Deployment",
    type: "chat",
    tools: true,
    vision: false,
    ready: false,
  };

  let picked = $state<string[] | null>(null);
  let primary = $state("");
  let titleModel = $state("");

  const preferred = $derived(data.models.find(m => m.ready) ?? data.models[0]);
  const selected = $derived(picked ?? (preferred ? [preferred.publicSpecifier] : []));
  const chosen = $derived(data.models.filter(m => selected.includes(m.publicSpecifier)));
  const entries = $derived(chosen.length > 0 ? chosen : [placeholder]);
  const effectivePrimary = $derived(selected.includes(primary) ? primary : selected[0] ?? placeholder.publicSpecifier);
  const effectiveTitleModel = $derived(selected.includes(titleModel) ? titleModel : effectivePrimary);

  function modelEntry(model: OrgModel) {
    if (!model.vision) return { name: model.name, tool_call: true };
    return {
      name: model.name,
      tool_call: true,
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    };
  }

  const configJson = $derived(JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    provider: {
      xinity: {
        npm: "@ai-sdk/openai-compatible",
        name: "Xinity AI",
        options: { baseURL: apiBase },
        models: Object.fromEntries(entries.map(m => [m.publicSpecifier, modelEntry(m)])),
      },
    },
    model: `xinity/${effectivePrimary}`,
    small_model: `xinity/${effectiveTitleModel}`,
  }, null, 2));

  function toggle(publicSpecifier: string) {
    picked = selected.includes(publicSpecifier)
      ? selected.filter(s => s !== publicSpecifier)
      : [...selected, publicSpecifier];
  }
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

  <section class="mb-6 bg-white rounded-lg shadow-md p-6">
    <h2 class="text-2xl font-bold mb-2">1. Choose your models</h2>
    <p class="text-gray-600 mb-4">
      Your organization's chat deployments that support tool calling. Deployments without it
      are left out, because an agent cannot read or edit a file without it.
    </p>

    {#if data.models.length === 0}
      <p class="mb-4 p-4 rounded bg-xinity-coral/10 text-gray-700">
        No chat deployment in your organization supports tool calling yet, so the config below
        uses a placeholder name. Deploy a tool-capable model in the
        <a href="/modelhub/" class="text-xinity-magenta hover:text-xinity-pink">Model Hub</a> first.
      </p>
    {:else}
      <ul class="space-y-2 mb-6">
        {#each data.models as model (model.publicSpecifier)}
          <li>
            <label class="flex items-center gap-3 p-3 rounded border cursor-pointer hover:bg-gray-50">
              <input
                type="checkbox"
                checked={selected.includes(model.publicSpecifier)}
                onchange={() => toggle(model.publicSpecifier)}
                class="accent-xinity-purple"
              />
              <span class="flex-1">
                <span class="font-medium">{model.name}</span>
                <code class="ml-2 text-sm text-gray-500">{model.publicSpecifier}</code>
              </span>
              {#if model.vision}
                <span class="inline-flex items-center gap-1 text-xs text-xinity-purple" title="Accepts images, declared as a modality in the config">
                  <Eye class="w-3 h-3" /> vision
                </span>
              {/if}
              {#if model.ready}
                <span class="inline-flex items-center gap-1 text-xs text-green-600" title="Serving now">
                  <CircleCheck class="w-3 h-3" /> ready
                </span>
              {/if}
            </label>
          </li>
        {/each}
      </ul>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label class="block">
          <span class="block text-sm font-medium mb-1">Default model</span>
          <select
            value={effectivePrimary}
            onchange={e => (primary = e.currentTarget.value)}
            class="w-full border rounded px-3 py-2"
          >
            {#each entries as model (model.publicSpecifier)}
              <option value={model.publicSpecifier}>{model.name}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="block text-sm font-medium mb-1">Title generation model</span>
          <select
            value={effectiveTitleModel}
            onchange={e => (titleModel = e.currentTarget.value)}
            class="w-full border rounded px-3 py-2"
          >
            {#each entries as model (model.publicSpecifier)}
              <option value={model.publicSpecifier}>{model.name}</option>
            {/each}
          </select>
          <span class="block text-sm text-gray-500 mt-1">
            Without this, OpenCode names sessions with a provider you have not configured.
            A small deployment is enough.
          </span>
        </label>
      </div>
    {/if}
  </section>

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
    <CodeExample code={`opencode auth login`} language="bash" withCopy />
    <p class="text-gray-600 mt-4">
      Choose "Other", enter <code class="bg-gray-100 px-1 rounded">xinity</code> as the provider id so it
      matches the config, and paste the key (<code class="bg-gray-100 px-1 rounded">sk_...</code>).
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
