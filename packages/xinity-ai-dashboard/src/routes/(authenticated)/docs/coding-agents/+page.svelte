<script lang="ts">
  import { ArrowLeft, Terminal } from "@lucide/svelte";
</script>

<svelte:head>
  <title>Coding Agents - Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <nav class="mb-6">
    <a href="/docs/" class="text-xinity-magenta hover:text-xinity-pink flex items-center gap-2">
      <ArrowLeft class="w-4 h-4" />
      All Docs
    </a>
  </nav>

  <h1 class="mb-2 text-4xl font-bold">Coding Agents</h1>
  <p class="mb-8 text-lg text-gray-600">
    Run an agent against your own deployments. The gateway speaks the OpenAI chat
    completions API, so agents that accept a custom provider can use it directly.
  </p>

  <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
    <a
      href="/docs/coding-agents/opencode/"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Terminal class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">OpenCode</h2>
      </div>
      <p class="text-sm text-gray-600">
        Generate an <code>opencode.json</code> naming the models your organization runs.
      </p>
    </a>
    <a
      href="/docs/coding-agents/pi/"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Terminal class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Pi</h2>
      </div>
      <p class="text-sm text-gray-600">
        Generate a <code>models.json</code> and create a key for Pi in one go.
      </p>
    </a>
    <a
      href="/docs/coding-agents/cline/"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Terminal class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Cline</h2>
      </div>
      <p class="text-sm text-gray-600">
        Generate a <code>models.json</code> that the Cline CLI and editor extension both read.
      </p>
    </a>
    <a
      href="/docs/coding-agents/crush/"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Terminal class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Crush</h2>
      </div>
      <p class="text-sm text-gray-600">
        Generate the <code>crushrc</code> lines and create a key for Crush in one go.
      </p>
    </a>
    <a
      href="/docs/coding-agents/goose/"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Terminal class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Goose</h2>
      </div>
      <p class="text-sm text-gray-600">
        Generate a custom provider file that the Goose CLI and desktop app both read.
      </p>
    </a>
  </div>
</div>

<style>
  code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }
</style>
