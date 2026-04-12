<script lang="ts">
  import { getClientEnv } from "$lib/clientEnv";
  import CodeExample from "$lib/components/CodeExample.svelte";
  const { GATEWAY_URL: apiBase } = getClientEnv();

  const pythonExample = `import os
from openai import OpenAI

client = OpenAI(
  api_key=os.getenv("API_KEY"),
  base_url="${apiBase}",
)

# Create a chat completion
response = client.chat.completions.create(
    model=os.getenv("MODEL"),
    messages=[
        { "role": "system", "content": "You are a helpful assistant." },
        { "role": "user", "content": "Hello! What can you help me with?" }
    ],
    temperature=0.7,
    max_tokens=1500,
)

print(response.choices[0].message.content)`;

  const javascriptExample = `import { OpenAI } from "openai";

const openai = new OpenAI({
    baseURL: "${apiBase}",
    apiKey: process.env.API_KEY,
});

async function chat() {
    const completion = await openai.chat.completions.create({
        model: process.env.MODEL,
        messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello! What can you help me with?" }
        ],
        temperature: 0.7,
        max_tokens: 1100,
    });

    console.log(completion.choices[0].message.content);
}

chat();`;

  const pythonXAppExample = `import os
from openai import OpenAI

client = OpenAI(
  api_key=os.getenv("API_KEY"),
  base_url="${apiBase}",
  default_headers={
      "X-Application": "my-chatbot",
  },
)

# All requests from this client will be tagged
# under the "my-chatbot" application
response = client.chat.completions.create(
    model=os.getenv("MODEL"),
    messages=[
        { "role": "user", "content": "Hello!" }
    ],
)

print(response.choices[0].message.content)`;

  const javascriptXAppExample = `import { OpenAI } from "openai";

const openai = new OpenAI({
    baseURL: "${apiBase}",
    apiKey: process.env.API_KEY,
    defaultHeaders: {
        "X-Application": "my-chatbot",
    },
});

// All requests from this client will be tagged
// under the "my-chatbot" application
const completion = await openai.chat.completions.create({
    model: process.env.MODEL,
    messages: [
        { role: "user", content: "Hello!" }
    ],
});

console.log(completion.choices[0].message.content);`;

  const curlXAppExample = `curl ${apiBase}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "X-Application: my-chatbot" \\
  -d '{
    "model": "'"'$MODEL'"'",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`;

  const pythonMetadataExample = `# Pass metadata to tag individual requests
response = client.chat.completions.create(
    model="<your-model>",
    messages=[
        { "role": "user", "content": "Summarize this document." }
    ],
    extra_body={
        "metadata": {
            "env": "production",
            "feature": "doc-summary",
            "user_tier": "enterprise",
        }
    },
)`;

  const javascriptMetadataExample = `// Pass metadata to tag individual requests
const completion = await openai.chat.completions.create({
    model: "<your-model>",
    messages: [
        { role: "user", content: "Summarize this document." }
    ],
    metadata: {
        env: "production",
        feature: "doc-summary",
        user_tier: "enterprise",
    },
});`;
</script>

<svelte:head>
  <title>Quick Start Guide - API Documentation</title>
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

  <h1 class="mb-4 text-4xl font-bold">Quick Start Guide</h1>
  <p class="mb-8 text-lg text-gray-600">
    Get started with the Xinity AI API in minutes
  </p>

  <!-- Step 1: Deploy a Model -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <div class="flex items-start gap-3 mb-4">
      <div
        class="flex-shrink-0 w-8 h-8 bg-xinity-purple text-white rounded-full flex items-center justify-center font-bold"
      >
        1
      </div>
      <div class="flex-1">
        <h2 class="text-2xl font-semibold mb-2">Deploy a Model</h2>
        <p class="text-gray-600 mb-4">
          Before you can use the API, you need to have a model deployed and
          running.
        </p>
        <ol class="list-decimal list-inside space-y-2 text-gray-700 ml-4">
          <li>
            Navigate to the <a
              href="/modelhub/"
              class="text-xinity-magenta hover:underline">Model Hub</a
            >
          </li>
          <li>Select a model you wish to use and click "Deploy"</li>
          <li>
            Wait for the model to be downloaded and set up. This process may
            take a few minutes depending on the model size.
          </li>
        </ol>
      </div>
    </div>
  </section>

  <!-- Step 2: Create API Key -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <div class="flex items-start gap-3 mb-4">
      <div
        class="flex-shrink-0 w-8 h-8 bg-xinity-purple text-white rounded-full flex items-center justify-center font-bold"
      >
        2
      </div>
      <div class="flex-1">
        <h2 class="text-2xl font-semibold mb-2">Create an API Key</h2>
        <p class="text-gray-600 mb-4">
          First, you'll need to create an API key to authenticate your requests.
        </p>
        <ol class="list-decimal list-inside space-y-2 text-gray-700 ml-4">
          <li>
            Navigate to the <a
              href="/ai-api-keys/"
              class="text-xinity-magenta hover:underline">API Keys page</a
            >
          </li>
          <li>Click the "Create New Key" button</li>
          <li>
            Give your key a descriptive name (e.g., "Production App",
            "Development")
          </li>
          <li>Copy the generated API key and store it securely</li>
        </ol>
        <div class="mt-4 p-4 bg-yellow-50 border-l-4 border-yellow-400 rounded">
          <p class="text-sm text-yellow-800">
            <strong>Important:</strong> Your API key will only be shown once. Make
            sure to copy and store it securely.
          </p>
        </div>
      </div>
    </div>
  </section>

  <!-- Step 3: Install SDK -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <div class="flex items-start gap-3 mb-4">
      <div
        class="flex-shrink-0 w-8 h-8 bg-xinity-purple text-white rounded-full flex items-center justify-center font-bold"
      >
        3
      </div>
      <div class="flex-1">
        <h2 class="text-2xl font-semibold mb-2">Install the OpenAI SDK</h2>
        <p class="text-gray-600 mb-4">
          Our API is compatible with the OpenAI SDK. Install it using your
          preferred package manager:
        </p>

        <div class="mb-4">
          <h3 class="font-semibold mb-2">Python</h3>
          <pre
            class="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto"><code
              >pip install openai</code
            ></pre>
        </div>

        <div class="mb-4">
          <h3 class="font-semibold mb-2">JavaScript/Node.js</h3>
          <pre
            class="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto"><code
              >npm install openai</code
            ></pre>
        </div>
      </div>
    </div>
  </section>

  <!-- Step 4: Make Your First Request -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <div class="flex items-start gap-3 mb-4">
      <div
        class="flex-shrink-0 w-8 h-8 bg-xinity-purple text-white rounded-full flex items-center justify-center font-bold"
      >
        4
      </div>
      <div class="flex-1">
        <h2 class="text-2xl font-semibold mb-2">Make Your First Request</h2>
        <p class="text-gray-600 mb-4">
          Here's a simple example to get you started:
        </p>

        <div class="mb-6">
          <h3 class="font-semibold mb-2">Python Example</h3>
          <CodeExample code={pythonExample} language="python" withCopy />
        </div>

        <div class="mb-4">
          <h3 class="font-semibold mb-2">JavaScript Example</h3>
          <CodeExample
            code={javascriptExample}
            language="javascript"
            withCopy
          />
        </div>
      </div>
    </div>
  </section>

  <!-- Step 5: Organize with Applications -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <div class="flex items-start gap-3 mb-4">
      <div
        class="flex-shrink-0 w-8 h-8 bg-xinity-purple text-white rounded-full flex items-center justify-center font-bold"
      >
        5
      </div>
      <div class="flex-1">
        <h2 class="text-2xl font-semibold mb-2">Organize Calls with Applications</h2>
        <p class="text-gray-600 mb-4">
          Use the <code class="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">X-Application</code> header to route API calls to different applications using a single API key. This is optional; if you skip it, calls are logged without an application.
        </p>

        <div class="mb-6">
          <h3 class="font-semibold mb-2">Python</h3>
          <CodeExample code={pythonXAppExample} language="python" withCopy />
        </div>

        <div class="mb-6">
          <h3 class="font-semibold mb-2">JavaScript</h3>
          <CodeExample code={javascriptXAppExample} language="javascript" withCopy />
        </div>

        <div class="mb-4">
          <h3 class="font-semibold mb-2">cURL</h3>
          <CodeExample code={curlXAppExample} language="bash" withCopy />
        </div>

        <div class="mt-4 p-4 bg-xinity-purple/10 border-l-4 border-xinity-purple rounded">
          <p class="text-sm text-xinity-pink">
            <strong>Tip:</strong> Set the header once via <code class="bg-xinity-purple/15 px-1 rounded text-xs font-mono">default_headers</code> (Python) or <code class="bg-xinity-purple/15 px-1 rounded text-xs font-mono">defaultHeaders</code> (JS) and all requests from that client will be tagged automatically. Create separate clients per application if needed.
          </p>
        </div>
      </div>
    </div>
  </section>

  <!-- Step 6: Attach Metadata -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <div class="flex items-start gap-3 mb-4">
      <div
        class="flex-shrink-0 w-8 h-8 bg-xinity-purple text-white rounded-full flex items-center justify-center font-bold"
      >
        6
      </div>
      <div class="flex-1">
        <h2 class="text-2xl font-semibold mb-2">Attach Metadata to Requests</h2>
        <p class="text-gray-600 mb-4">
          Add custom key-value metadata to any request for fine-grained filtering and analysis in the dashboard. Metadata is stored as JSON and can be searched later.
        </p>

        <div class="mb-6">
          <h3 class="font-semibold mb-2">Python</h3>
          <CodeExample code={pythonMetadataExample} language="python" withCopy />
        </div>

        <div class="mb-4">
          <h3 class="font-semibold mb-2">JavaScript</h3>
          <CodeExample code={javascriptMetadataExample} language="javascript" withCopy />
        </div>

        <div class="mt-4 p-4 bg-xinity-purple/10 border-l-4 border-xinity-purple rounded">
          <p class="text-sm text-xinity-pink">
            <strong>Tip:</strong> Use metadata to tag calls by environment, feature, user segment, or any other dimension. You can filter by metadata key/value pairs in the Data section of the dashboard.
          </p>
        </div>
      </div>
    </div>
  </section>

  <!-- Step 7: Common Use Cases -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <div class="flex items-start gap-3 mb-4">
      <div
        class="flex-shrink-0 w-8 h-8 bg-xinity-purple text-white rounded-full flex items-center justify-center font-bold"
      >
        7
      </div>
      <div class="flex-1">
        <h2 class="text-2xl font-semibold mb-2">Common Use Cases</h2>
        <p class="text-gray-600 mb-4">
          Here are some popular ways to use the Xinity AI API:
        </p>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="p-4 border rounded-lg">
            <h3 class="font-semibold mb-2">Chatbots</h3>
            <p class="text-sm text-gray-600">
              Build intelligent conversational agents for customer support or
              engagement.
            </p>
          </div>
          <div class="p-4 border rounded-lg">
            <h3 class="font-semibold mb-2">Content Generation</h3>
            <p class="text-sm text-gray-600">
              Generate articles, product descriptions, or marketing copy
              automatically.
            </p>
          </div>
          <div class="p-4 border rounded-lg">
            <h3 class="font-semibold mb-2">Text Analysis</h3>
            <p class="text-sm text-gray-600">
              Analyze sentiment, extract entities, or summarize documents.
            </p>
          </div>
          <div class="p-4 border rounded-lg">
            <h3 class="font-semibold mb-2">Translation</h3>
            <p class="text-sm text-gray-600">
              Translate text between languages with high accuracy.
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Next Steps -->
  <section class="p-6 bg-gradient-to-r from-xinity-purple/10 to-xinity-coral/10 rounded-lg">
    <h2 class="text-2xl font-semibold mb-4">Next Steps</h2>
    <div class="space-y-3">
      <a
        href="/docs/applications"
        class="block p-4 bg-white rounded-lg shadow hover:shadow-md transition"
      >
        <h3 class="font-semibold text-xinity-purple">
          Learn About Applications
        </h3>
        <p class="text-sm text-gray-600">
          Organize calls for labeling, distillation, and fine-tuning
        </p>
      </a>
      <a
        href="/docs/api-reference"
        class="block p-4 bg-white rounded-lg shadow hover:shadow-md transition"
      >
        <h3 class="font-semibold text-xinity-purple">
          Explore the API Reference
        </h3>
        <p class="text-sm text-gray-600">
          Learn about all available endpoints and parameters
        </p>
      </a>
      <a
        href="/docs/code-examples"
        class="block p-4 bg-white rounded-lg shadow hover:shadow-md transition"
      >
        <h3 class="font-semibold text-xinity-purple">View More Code Examples</h3>
        <p class="text-sm text-gray-600">
          See advanced examples and integration patterns
        </p>
      </a>
      <a
        href="/training"
        class="block p-4 bg-white rounded-lg shadow hover:shadow-md transition"
      >
        <h3 class="font-semibold text-xinity-purple">Fine-tune Your Model</h3>
        <p class="text-sm text-gray-600">
          Customize the AI for your specific use case
        </p>
      </a>
    </div>
  </section>
</div>
