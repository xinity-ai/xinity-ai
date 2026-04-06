<script lang="ts">
  import { clientEnv } from "$lib/clientEnv";
  import CodeExample from "$lib/components/CodeExample.svelte";
  const apiBase = clientEnv.PUBLIC_LLM_API_URL;

  const pythonMultiApp = `import os
from openai import OpenAI

api_key = os.getenv("API_KEY")

# One client per application
chatbot = OpenAI(
    api_key=api_key,
    base_url="${apiBase}",
    default_headers={"X-Application": "customer-chatbot"},
)

summarizer = OpenAI(
    api_key=api_key,
    base_url="${apiBase}",
    default_headers={"X-Application": "doc-summarizer"},
)

# Calls are automatically routed to the right application
chatbot.chat.completions.create(
    model="<your-model>",
    messages=[{"role": "user", "content": "How do I reset my password?"}],
)

summarizer.chat.completions.create(
    model="<your-model>",
    messages=[{"role": "user", "content": "Summarize this report..."}],
)`;

  const jsMultiApp = `import { OpenAI } from "openai";

const apiKey = process.env.API_KEY;

// One client per application
const chatbot = new OpenAI({
    apiKey,
    baseURL: "${apiBase}",
    defaultHeaders: { "X-Application": "customer-chatbot" },
});

const summarizer = new OpenAI({
    apiKey,
    baseURL: "${apiBase}",
    defaultHeaders: { "X-Application": "doc-summarizer" },
});

// Calls are automatically routed to the right application
await chatbot.chat.completions.create({
    model: "<your-model>",
    messages: [{ role: "user", content: "How do I reset my password?" }],
});

await summarizer.chat.completions.create({
    model: "<your-model>",
    messages: [{ role: "user", content: "Summarize this report..." }],
});`;

  const pythonMetadataLabeling = `# Attach metadata for fine-grained labeling later
response = client.chat.completions.create(
    model="<your-model>",
    messages=[
        {"role": "user", "content": "Translate to German: Hello world"}
    ],
    extra_body={
        "metadata": {
            "task": "translation",
            "source_lang": "en",
            "target_lang": "de",
            "department": "localization",
        }
    },
)`;
</script>

<svelte:head>
  <title>Applications - API Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
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

  <h1 class="mb-4 text-4xl font-bold">Applications</h1>
  <p class="mb-8 text-lg text-gray-600">
    Organize your API calls into logical groups for data collection, labeling, and fine-tuning
  </p>

  <!-- What are Applications -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">What are Applications?</h2>
    <p class="text-gray-600 mb-4">
      Applications let you group API calls by purpose. Instead of creating a separate API key for every use case, you use a single key and tag each request with the application it belongs to.
    </p>
    <p class="text-gray-600 mb-4">
      This separation matters because different use cases produce different kinds of data. A customer support chatbot generates conversational exchanges, while a document summarizer produces condensed outputs. Keeping these separate lets you:
    </p>
    <ul class="space-y-2 text-gray-700 ml-4">
      <li class="flex items-start gap-2">
        <span class="text-xinity-magenta font-bold mt-1">&#8226;</span>
        <span><strong>Label data per use case:</strong> Review and rate responses within the context they were generated for</span>
      </li>
      <li class="flex items-start gap-2">
        <span class="text-xinity-magenta font-bold mt-1">&#8226;</span>
        <span><strong>Build targeted training sets:</strong> Export clean, focused datasets for distillation or fine-tuning specific to each application</span>
      </li>
      <li class="flex items-start gap-2">
        <span class="text-xinity-magenta font-bold mt-1">&#8226;</span>
        <span><strong>Track quality independently:</strong> Compare performance across applications without cross-contamination</span>
      </li>
      <li class="flex items-start gap-2">
        <span class="text-xinity-magenta font-bold mt-1">&#8226;</span>
        <span><strong>Simplify key management:</strong> Use one API key for multiple applications instead of managing one key per use case</span>
      </li>
    </ul>
  </section>

  <!-- How it Works -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">How it Works</h2>

    <div class="space-y-6">
      <div>
        <h3 class="text-lg font-semibold mb-2">1. Create Applications in the Dashboard</h3>
        <p class="text-gray-600">
          Go to the <a href="/ai-api-keys/" class="text-xinity-magenta hover:underline">API Keys page</a> and create applications in the Application Manager. Give each one a descriptive name (e.g. "customer-chatbot", "doc-summarizer", "code-reviewer").
        </p>
      </div>

      <div>
        <h3 class="text-lg font-semibold mb-2">2. Tag Requests with the X-Application Header</h3>
        <p class="text-gray-600 mb-4">
          Add the <code class="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">X-Application</code> header to your API requests with the application name. The simplest approach is to set it once as a default header on your client:
        </p>
        <div class="mb-4">
          <h4 class="font-semibold mb-2 text-sm text-gray-500">Python</h4>
          <CodeExample code={pythonMultiApp} language="python" withCopy />
        </div>
        <div>
          <h4 class="font-semibold mb-2 text-sm text-gray-500">JavaScript</h4>
          <CodeExample code={jsMultiApp} language="javascript" withCopy />
        </div>
      </div>

      <div>
        <h3 class="text-lg font-semibold mb-2">3. View and Label Data per Application</h3>
        <p class="text-gray-600">
          In the <a href="/data/" class="text-xinity-magenta hover:underline">Data section</a>, each application has its own page where you can browse calls, rate responses, edit outputs, and highlight passages. This labeled data can then be exported for fine-tuning.
        </p>
      </div>
    </div>
  </section>

  <!-- Applications vs API Keys -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Applications vs API Keys</h2>
    <p class="text-gray-600 mb-4">
      API keys are for <strong>authentication</strong>. Applications are for <strong>organization</strong>. They serve different purposes:
    </p>
    <div class="overflow-x-auto">
      <table class="w-full border-collapse border border-gray-300">
        <thead class="bg-gray-50">
          <tr>
            <th class="border border-gray-300 px-4 py-2 text-left"></th>
            <th class="border border-gray-300 px-4 py-2 text-left">API Keys</th>
            <th class="border border-gray-300 px-4 py-2 text-left">Applications</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-medium">Purpose</td>
            <td class="border border-gray-300 px-4 py-2">Authenticate requests</td>
            <td class="border border-gray-300 px-4 py-2">Group and categorize call data</td>
          </tr>
          <tr class="bg-gray-50">
            <td class="border border-gray-300 px-4 py-2 font-medium">Scope</td>
            <td class="border border-gray-300 px-4 py-2">Per deployment environment, team, or service</td>
            <td class="border border-gray-300 px-4 py-2">Per use case or feature</td>
          </tr>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-medium">Example</td>
            <td class="border border-gray-300 px-4 py-2">"production-backend", "staging"</td>
            <td class="border border-gray-300 px-4 py-2">"customer-chatbot", "doc-summarizer"</td>
          </tr>
          <tr class="bg-gray-50">
            <td class="border border-gray-300 px-4 py-2 font-medium">Set via</td>
            <td class="border border-gray-300 px-4 py-2"><code class="bg-gray-100 px-1 rounded text-xs font-mono">Authorization</code> header</td>
            <td class="border border-gray-300 px-4 py-2"><code class="bg-gray-100 px-1 rounded text-xs font-mono">X-Application</code> header</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="mt-4 p-4 bg-xinity-purple/10 border-l-4 border-xinity-purple rounded">
      <p class="text-sm text-xinity-pink">
        <strong>Tip:</strong> A single API key can route calls to many applications. You only need multiple keys when you want separate credentials (e.g. for different teams or environments).
      </p>
    </div>
  </section>

  <!-- The Data Pipeline -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">The Data Pipeline: From Calls to Fine-Tuning</h2>
    <p class="text-gray-600 mb-4">
      Applications are the foundation of a data pipeline that turns raw API calls into high-quality training data:
    </p>

    <div class="space-y-4">
      <div class="flex gap-4 items-start p-4 rounded border">
        <div class="shrink-0 w-8 h-8 bg-xinity-purple text-white rounded-full flex items-center justify-center font-bold text-sm">1</div>
        <div>
          <h3 class="font-semibold">Collect</h3>
          <p class="text-sm text-gray-600">API calls are automatically logged under their application. Use metadata to add additional context like user segment or feature flag.</p>
        </div>
      </div>
      <div class="flex gap-4 items-start p-4 rounded border">
        <div class="shrink-0 w-8 h-8 bg-xinity-purple text-white rounded-full flex items-center justify-center font-bold text-sm">2</div>
        <div>
          <h3 class="font-semibold">Label</h3>
          <p class="text-sm text-gray-600">In the Data section, review calls per application. Rate responses (thumbs up/down), edit outputs to show the ideal answer, and highlight good or bad passages.</p>
        </div>
      </div>
      <div class="flex gap-4 items-start p-4 rounded border">
        <div class="shrink-0 w-8 h-8 bg-xinity-purple text-white rounded-full flex items-center justify-center font-bold text-sm">3</div>
        <div>
          <h3 class="font-semibold">Fine-Tune</h3>
          <p class="text-sm text-gray-600">Export labeled data as a clean training set. Because each application's data is isolated, you can fine-tune a model specifically for one use case without noise from others.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Metadata for extra granularity -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Metadata for Extra Granularity</h2>
    <p class="text-gray-600 mb-4">
      Within an application, you can add <code class="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">metadata</code> to individual requests for finer-grained tagging. This is useful when you want to slice data within an application without creating more applications.
    </p>
    <CodeExample code={pythonMetadataLabeling} language="python" withCopy />
    <p class="text-gray-600 mt-4">
      You can then filter calls by metadata key/value pairs in the Data section. For example, find all translation calls for the localization department, or all calls tagged with a specific feature flag.
    </p>
  </section>

  <!-- Uncategorized calls -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Uncategorized Calls</h2>
    <p class="text-gray-600 mb-4">
      Requests that don't include the <code class="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">X-Application</code> header land in the "Uncategorized" bucket in the Data section. This is by design. You can start using the API immediately without any setup, and organize calls later when you're ready.
    </p>
    <p class="text-gray-600">
      If an API key has a default application assigned, requests from that key will use it automatically unless the <code class="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">X-Application</code> header overrides it.
    </p>
  </section>

  <!-- Data Collection Toggle -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Controlling Data Collection</h2>
    <p class="text-gray-600 mb-4">
      Each API key has a <strong>data collection toggle</strong>. When disabled, request and response content won't be stored, only usage metrics are recorded. This is useful for keys used in environments where you don't want to retain conversation data.
    </p>
    <p class="text-gray-600">
      You can toggle data collection per key from the <a href="/ai-api-keys/" class="text-xinity-magenta hover:underline">API Keys page</a>.
    </p>
  </section>

  <!-- Related Links -->
  <section class="p-6 bg-linear-to-r from-xinity-purple/10 to-xinity-coral/10 rounded-lg">
    <h2 class="text-2xl font-semibold mb-4">Related Documentation</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      <a
        href="/docs/quick-start"
        class="block p-4 bg-white rounded-lg shadow hover:shadow-md transition"
      >
        <h3 class="font-semibold text-xinity-purple">Quick Start Guide</h3>
        <p class="text-sm text-gray-600">Get started with the API in minutes</p>
      </a>
      <a
        href="/docs/api-reference"
        class="block p-4 bg-white rounded-lg shadow hover:shadow-md transition"
      >
        <h3 class="font-semibold text-xinity-purple">API Reference</h3>
        <p class="text-sm text-gray-600">Complete endpoint documentation</p>
      </a>
    </div>
  </section>
</div>
