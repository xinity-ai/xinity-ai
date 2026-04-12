<script lang="ts">
  import { getClientEnv } from "$lib/clientEnv";
  import CodeExample from "$lib/components/CodeExample.svelte";
  const { GATEWAY_URL: apiBase } = getClientEnv();

  const authHeader = `Authorization: Bearer YOUR_API_KEY`;

  const exampleRequest = `{
  "model": "<your-model>",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What is the capital of France?"}
  ],
  "temperature": 0.7,
  "max_tokens": 1500,
  "metadata": {
    "env": "production",
    "feature": "geography-qa"
  }
}`;

  const exampleResponse = `{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "<your-model>",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 8,
    "total_tokens": 28
  }
}`;

  const modelsResponse = `{
  "object": "list",
  "data": [
    {
      "id": "<your-model>",
      "object": "model",
      "created": 1677610602,
      "owned_by": "xinity-ai"
    }
  ]
}`;

  const errorResponse = `{
  "error": {
    "message": "Invalid API key provided",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}`;
</script>

<svelte:head>
  <title>API Reference - API Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-5xl">
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

  <h1 class="mb-4 text-4xl font-bold">API Reference</h1>
  <p class="mb-8 text-lg text-gray-600">
    Complete reference for all available API endpoints
  </p>

  <!-- Base URL -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Base URL</h2>
    <CodeExample code={apiBase} language="bash" withCopy />
  </section>

  <!-- Authentication -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Authentication</h2>
    <p class="text-gray-600 mb-4">
      All API requests require authentication using an API key. Include your API
      key in the request headers:
    </p>
    <CodeExample code={authHeader} language="bash" withCopy />
    <div class="mt-4 p-4 bg-xinity-purple/10 border-l-4 border-xinity-purple rounded">
      <p class="text-sm text-xinity-pink">
        <strong>Tip:</strong> Store your API key securely and never commit it to
        version control.
      </p>
    </div>
  </section>

  <!-- Custom Headers -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Custom Headers</h2>

    <div class="overflow-x-auto">
      <table class="w-full border-collapse border border-gray-300 mb-4">
        <thead class="bg-gray-50">
          <tr>
            <th class="border border-gray-300 px-4 py-2 text-left">Header</th>
            <th class="border border-gray-300 px-4 py-2 text-left">Required</th>
            <th class="border border-gray-300 px-4 py-2 text-left">Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm">X-Application</td>
            <td class="border border-gray-300 px-4 py-2">No</td>
            <td class="border border-gray-300 px-4 py-2">
              Routes the request to a named application for data organization. The value must match the name of an existing application in your organization.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- Chat Completions Endpoint -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <div class="flex items-center gap-2 mb-4">
      <span
        class="px-3 py-1 bg-green-100 text-green-800 rounded font-mono text-sm font-semibold"
        >POST</span
      >
      <h2 class="text-2xl font-semibold">/v1/chat/completions</h2>
    </div>
    <p class="text-gray-600 mb-4">
      Create a chat completion using your fine-tuned model. This endpoint is compatible with the OpenAI Chat Completions API. See the <a href="https://platform.openai.com/docs/api-reference/chat/create" class="text-xinity-magenta hover:underline" target="_blank" rel="noopener">OpenAI API reference</a> for the full list of supported parameters.
    </p>

    <h3 class="text-lg font-semibold mb-3">Request Body</h3>
    <div class="overflow-x-auto">
      <table class="w-full border-collapse border border-gray-300 mb-4">
        <thead class="bg-gray-50">
          <tr>
            <th class="border border-gray-300 px-4 py-2 text-left">Parameter</th
            >
            <th class="border border-gray-300 px-4 py-2 text-left">Type</th>
            <th class="border border-gray-300 px-4 py-2 text-left">Required</th>
            <th class="border border-gray-300 px-4 py-2 text-left"
              >Description</th
            >
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >model</td
            >
            <td class="border border-gray-300 px-4 py-2">string</td>
            <td class="border border-gray-300 px-4 py-2">Yes</td>
            <td class="border border-gray-300 px-4 py-2"
              >Model identifier (e.g., "{"<"}your-model{">"}")</td
            >
          </tr>
          <tr class="bg-gray-50">
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >messages</td
            >
            <td class="border border-gray-300 px-4 py-2">array</td>
            <td class="border border-gray-300 px-4 py-2">Yes</td>
            <td class="border border-gray-300 px-4 py-2"
              >Array of message objects with role and content</td
            >
          </tr>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >temperature</td
            >
            <td class="border border-gray-300 px-4 py-2">number</td>
            <td class="border border-gray-300 px-4 py-2">No</td>
            <td class="border border-gray-300 px-4 py-2"
              >Sampling temperature (0.0 - 2.0). Default: 0.7</td
            >
          </tr>
          <tr class="bg-gray-50">
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >max_tokens</td
            >
            <td class="border border-gray-300 px-4 py-2">integer</td>
            <td class="border border-gray-300 px-4 py-2">No</td>
            <td class="border border-gray-300 px-4 py-2"
              >Maximum tokens to generate. Default: 150</td
            >
          </tr>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >top_p</td
            >
            <td class="border border-gray-300 px-4 py-2">number</td>
            <td class="border border-gray-300 px-4 py-2">No</td>
            <td class="border border-gray-300 px-4 py-2"
              >Nucleus sampling parameter (0.0 - 1.0). Default: 1.0</td
            >
          </tr>
          <tr class="bg-gray-50">
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >stream</td
            >
            <td class="border border-gray-300 px-4 py-2">boolean</td>
            <td class="border border-gray-300 px-4 py-2">No</td>
            <td class="border border-gray-300 px-4 py-2"
              >Enable streaming responses. Default: false</td
            >
          </tr>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >metadata</td
            >
            <td class="border border-gray-300 px-4 py-2">object</td>
            <td class="border border-gray-300 px-4 py-2">No</td>
            <td class="border border-gray-300 px-4 py-2"
              >Arbitrary key-value pairs for tagging and filtering calls in the dashboard</td
            >
          </tr>
        </tbody>
      </table>
    </div>

    <h3 class="text-lg font-semibold mb-3">Example Request</h3>
    <CodeExample code={exampleRequest} language="javascript" withCopy />

    <h3 class="text-lg font-semibold mt-4 mb-3">Response</h3>
    <CodeExample code={exampleResponse} language="javascript" />
  </section>

  <!-- Models Endpoint -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <div class="flex items-center gap-2 mb-4">
      <span
        class="px-3 py-1 bg-xinity-purple/15 text-xinity-pink rounded font-mono text-sm font-semibold"
        >GET</span
      >
      <h2 class="text-2xl font-semibold">/v1/models</h2>
    </div>
    <p class="text-gray-600 mb-4">
      List all available models for your account.
    </p>

    <h3 class="text-lg font-semibold mb-3">Example Response</h3>
    <CodeExample code={modelsResponse} language="javascript" />
  </section>

  <!-- Rerank Endpoint -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <div class="flex items-center gap-2 mb-4">
      <span
        class="px-3 py-1 bg-green-100 text-green-800 rounded font-mono text-sm font-semibold"
        >POST</span
      >
      <h2 class="text-2xl font-semibold">/v1/rerank</h2>
    </div>
    <p class="text-gray-600 mb-4">
      Rerank a list of documents by relevance to a query. This endpoint follows the Cohere v1 rerank API, which has become the community standard for reranking. See the <a href="https://docs.cohere.com/v1/reference/rerank" class="text-xinity-magenta hover:underline" target="_blank" rel="noopener">Cohere v1 rerank reference</a> for full details.
    </p>

    <h3 class="text-lg font-semibold mb-3">Request Body</h3>
    <div class="overflow-x-auto">
      <table class="w-full border-collapse border border-gray-300 mb-4">
        <thead class="bg-gray-50">
          <tr>
            <th class="border border-gray-300 px-4 py-2 text-left">Parameter</th>
            <th class="border border-gray-300 px-4 py-2 text-left">Type</th>
            <th class="border border-gray-300 px-4 py-2 text-left">Required</th>
            <th class="border border-gray-300 px-4 py-2 text-left">Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm">model</td>
            <td class="border border-gray-300 px-4 py-2">string</td>
            <td class="border border-gray-300 px-4 py-2">Yes</td>
            <td class="border border-gray-300 px-4 py-2">Model identifier. Must be a rerank-type model.</td>
          </tr>
          <tr class="bg-gray-50">
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm">query</td>
            <td class="border border-gray-300 px-4 py-2">string</td>
            <td class="border border-gray-300 px-4 py-2">Yes</td>
            <td class="border border-gray-300 px-4 py-2">The search query to rank documents against.</td>
          </tr>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm">documents</td>
            <td class="border border-gray-300 px-4 py-2">string[] | object[]</td>
            <td class="border border-gray-300 px-4 py-2">Yes</td>
            <td class="border border-gray-300 px-4 py-2">Documents to rerank. Can be plain strings or objects.</td>
          </tr>
          <tr class="bg-gray-50">
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm">top_n</td>
            <td class="border border-gray-300 px-4 py-2">integer</td>
            <td class="border border-gray-300 px-4 py-2">No</td>
            <td class="border border-gray-300 px-4 py-2">Number of top results to return. Defaults to all documents.</td>
          </tr>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm">return_documents</td>
            <td class="border border-gray-300 px-4 py-2">boolean</td>
            <td class="border border-gray-300 px-4 py-2">No</td>
            <td class="border border-gray-300 px-4 py-2">Whether to include the document content in the response. Default: true</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- Error Codes -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Error Codes</h2>
    <p class="text-gray-600 mb-4">
      The API uses standard HTTP status codes to indicate success or failure:
    </p>

    <div class="overflow-x-auto">
      <table class="w-full border-collapse border border-gray-300">
        <thead class="bg-gray-50">
          <tr>
            <th class="border border-gray-300 px-4 py-2 text-left"
              >Status Code</th
            >
            <th class="border border-gray-300 px-4 py-2 text-left"
              >Description</th
            >
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >200</td
            >
            <td class="border border-gray-300 px-4 py-2">Success</td>
          </tr>
          <tr class="bg-gray-50">
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >400</td
            >
            <td class="border border-gray-300 px-4 py-2"
              >Bad Request: invalid parameters</td
            >
          </tr>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >401</td
            >
            <td class="border border-gray-300 px-4 py-2"
              >Unauthorized: invalid or missing API key</td
            >
          </tr>
          <tr class="bg-gray-50">
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >429</td
            >
            <td class="border border-gray-300 px-4 py-2"
              >Too Many Requests: the inference backend queue is full. Retry with exponential backoff.</td
            >
          </tr>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >500</td
            >
            <td class="border border-gray-300 px-4 py-2"
              >Internal Server Error</td
            >
          </tr>
          <tr class="bg-gray-50">
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >503</td
            >
            <td class="border border-gray-300 px-4 py-2"
              >Service Unavailable: backend is unreachable (e.g. restarting). Retry after the duration in the <code class="text-xs font-mono bg-gray-100 px-1 rounded">Retry-After</code> header.</td
            >
          </tr>
          <tr>
            <td class="border border-gray-300 px-4 py-2 font-mono text-sm"
              >504</td
            >
            <td class="border border-gray-300 px-4 py-2"
              >Gateway Timeout: backend took too long to respond. Retry with exponential backoff.</td
            >
          </tr>
        </tbody>
      </table>
    </div>

    <h3 class="text-lg font-semibold mb-3 mt-6">Error Response Format</h3>
    <CodeExample code={errorResponse} language="javascript" />
  </section>

  <!-- Best Practices -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Best Practices</h2>
    <ul class="space-y-3">
      <li class="flex items-start gap-3">
        <span class="text-green-600 text-xl">&#10003;</span>
        <div>
          <strong>Implement exponential backoff</strong> when retrying failed requests
        </div>
      </li>
      <li class="flex items-start gap-3">
        <span class="text-green-600 text-xl">&#10003;</span>
        <div>
          <strong>Cache responses</strong> when appropriate to reduce API calls
        </div>
      </li>
      <li class="flex items-start gap-3">
        <span class="text-green-600 text-xl">&#10003;</span>
        <div>
          <strong>Use streaming</strong> for long-form content to improve user experience
        </div>
      </li>
      <li class="flex items-start gap-3">
        <span class="text-green-600 text-xl">&#10003;</span>
        <div>
          <strong>Set appropriate max_tokens</strong> to control response length
        </div>
      </li>
      <li class="flex items-start gap-3">
        <span class="text-green-600 text-xl">&#10003;</span>
        <div>
          <strong>Use the X-Application header</strong> to organize calls by application
          without needing separate API keys
        </div>
      </li>
      <li class="flex items-start gap-3">
        <span class="text-green-600 text-xl">&#10003;</span>
        <div>
          <strong>Attach metadata</strong> to requests for granular filtering and analysis
        </div>
      </li>
    </ul>
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
        <p class="text-sm text-gray-600">Get started in minutes</p>
      </a>
      <a
        href="/docs/code-examples"
        class="block p-4 bg-white rounded-lg shadow hover:shadow-md transition"
      >
        <h3 class="font-semibold text-xinity-purple">Code Examples</h3>
        <p class="text-sm text-gray-600">See practical implementations</p>
      </a>
    </div>
  </section>
</div>
