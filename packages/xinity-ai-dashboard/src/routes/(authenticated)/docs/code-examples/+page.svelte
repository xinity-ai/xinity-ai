<script lang="ts">
  import { getClientEnv } from "$lib/clientEnv";
  import CodeExample from "$lib/components/CodeExample.svelte";
  import { getExamples, type Language } from "$lib/assets/code-examples/loader";

  const { GATEWAY_URL: apiBase } = getClientEnv();
  const examples = getExamples(apiBase);

  let selectedLanguage: Language = $state("python");
  let selectedExample = $state("basic-chat");

  const exampleMeta: Record<string, { title: string; description: string }> = {
    "basic-chat": {
      title: "Basic Chat Completion",
      description: "Simple chat completion with a single message",
    },
    conversation: {
      title: "Multi-turn Conversation",
      description: "Maintain context across multiple messages",
    },
    streaming: {
      title: "Streaming Responses",
      description: "Stream responses in real-time for better UX",
    },
    "error-handling": {
      title: "Error Handling",
      description: "Handle API errors and retries. A 429 can occur when the inference backend's request queue is full and it cannot accept more load. Implement exponential backoff to recover gracefully.",
    },
    "tool-calling": {
      title: "Tool Calling",
      description: "Use function calling to give models access to external tools",
    },
    "structured-output": {
      title: "Structured Output",
      description: "Get JSON responses that conform to a schema",
    },
    reranking: {
      title: "Reranking",
      description: "Rerank documents by relevance to a query. The /v1/rerank endpoint follows the Cohere rerank API standard, which has become the community convention.",
    },
  };

  const exampleOrder = [
    "basic-chat",
    "conversation",
    "streaming",
    "error-handling",
    "tool-calling",
    "structured-output",
    "reranking",
  ];
</script>

<svelte:head>
  <title>Code Examples - API Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-6xl">
  <nav class="mb-6">
    <a
      href="/docs/"
      class="text-xinity-magenta hover:text-xinity-pink flex items-center gap-2"
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

  <h1 class="mb-4 text-4xl font-bold">Code Examples</h1>
  <p class="mb-8 text-lg text-gray-600">
    Practical examples for common use cases
  </p>

  <div class="grid grid-cols-1 lg:grid-cols-4 gap-6">
    <!-- Sidebar with example selection -->
    <div class="lg:col-span-1">
      <div class="bg-white rounded-lg shadow-md p-4 sticky top-4">
        <h2 class="font-semibold mb-4 text-lg">Examples</h2>
        <nav class="space-y-2">
          {#each exampleOrder as slug}
            <button
              class="w-full text-left px-3 py-2 rounded transition {selectedExample ===
              slug
                ? 'bg-xinity-purple/15 text-xinity-pink font-semibold'
                : 'hover:bg-gray-100'}"
              onclick={() => (selectedExample = slug)}
            >
              {exampleMeta[slug].title}
            </button>
          {/each}
        </nav>
      </div>
    </div>

    <!-- Main content area -->
    <div class="lg:col-span-3">
      <div class="bg-white rounded-lg shadow-md p-6">
        <h2 class="text-2xl font-bold mb-2">
          {exampleMeta[selectedExample].title}
        </h2>
        <p class="text-gray-600 mb-6">
          {exampleMeta[selectedExample].description}
        </p>

        <!-- Language tabs -->
        <div class="mb-4 border-b border-gray-200">
          <ul class="flex flex-wrap -mb-px text-sm font-medium">
            <li class="mr-2">
              <button
                class="inline-block p-4 border-b-2 rounded-t-lg {selectedLanguage ===
                'python'
                  ? 'text-xinity-magenta border-xinity-magenta'
                  : 'border-transparent hover:text-gray-600 hover:border-gray-300'}"
                onclick={() => (selectedLanguage = "python")}
              >
                Python
              </button>
            </li>
            <li class="mr-2">
              <button
                class="inline-block p-4 border-b-2 rounded-t-lg {selectedLanguage ===
                'javascript'
                  ? 'text-xinity-magenta border-xinity-magenta'
                  : 'border-transparent hover:text-gray-600 hover:border-gray-300'}"
                onclick={() => (selectedLanguage = "javascript")}
              >
                JavaScript
              </button>
            </li>
            <li class="mr-2">
              <button
                class="inline-block p-4 border-b-2 rounded-t-lg {selectedLanguage ===
                'bash'
                  ? 'text-xinity-magenta border-xinity-magenta'
                  : 'border-transparent hover:text-gray-600 hover:border-gray-300'}"
                onclick={() => (selectedLanguage = "bash")}
              >
                cURL
              </button>
            </li>
          </ul>
        </div>

        <!-- Code display -->
        {#if examples[selectedExample]?.[selectedLanguage]}
          <CodeExample
            code={examples[selectedExample][selectedLanguage]!}
            language={selectedLanguage}
            withCopy
          />
        {/if}
      </div>

      <!-- Tips section -->
      <div
        class="mt-6 p-6 bg-linear-to-r from-xinity-purple/10 to-xinity-coral/10 rounded-lg"
      >
        <h3 class="text-xl font-semibold mb-4">Tips & Best Practices</h3>
        <ul class="space-y-2 text-gray-700">
          <li class="flex items-start gap-2">
            <span class="text-xinity-magenta font-bold">&#8226;</span>
            <span
              >Always store your API key in environment variables, never
              hardcode it</span
            >
          </li>
          <li class="flex items-start gap-2">
            <span class="text-xinity-magenta font-bold">&#8226;</span>
            <span>Implement exponential backoff when retrying failed requests</span>
          </li>
          <li class="flex items-start gap-2">
            <span class="text-xinity-magenta font-bold">&#8226;</span>
            <span
              >Use streaming for long-form content to improve perceived
              performance and avoid request timeouts from long waiting times</span
            >
          </li>
          <li class="flex items-start gap-2">
            <span class="text-xinity-magenta font-bold">&#8226;</span>
            <span
              >Monitor your API usage on the dashboard to track call volume</span
            >
          </li>
          <li class="flex items-start gap-2">
            <span class="text-xinity-magenta font-bold">&#8226;</span>
            <span
              >Set appropriate <code class="bg-white px-1 rounded"
                >max_tokens</code
              > limits to control response length</span
            >
          </li>
        </ul>
      </div>

      <!-- Related links -->
      <div class="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        <a
          href="/docs/quick-start"
          class="block p-4 bg-white rounded-lg shadow hover:shadow-md transition"
        >
          <h3 class="font-semibold text-xinity-purple mb-1">Quick Start Guide</h3>
          <p class="text-sm text-gray-600">Get started in minutes</p>
        </a>
        <a
          href="/docs/api-reference"
          class="block p-4 bg-white rounded-lg shadow hover:shadow-md transition"
        >
          <h3 class="font-semibold text-xinity-purple mb-1">API Reference</h3>
          <p class="text-sm text-gray-600">Complete endpoint documentation</p>
        </a>
      </div>
    </div>
  </div>
</div>

<style>
  code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }
</style>
