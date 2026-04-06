<script lang="ts">
  import { Rocket, BookOpen, Code, Layers, ShieldCheck, Cpu, Users, Tag, Plug, Wrench } from "@lucide/svelte";
</script>

<svelte:head>
  <title>Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <h1 class="mb-2 text-4xl font-bold">Documentation</h1>
  <p class="mb-8 text-lg text-gray-600">
    Guides and references for integrating with the Xinity AI API
  </p>

  <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
    <a
      href="/docs/quick-start"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Rocket class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Quick Start Guide</h2>
      </div>
      <p class="text-sm text-gray-600">
        Deploy a model, create an API key, and make your first request in minutes.
      </p>
    </a>

    <a
      href="/docs/applications"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Layers class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Applications</h2>
      </div>
      <p class="text-sm text-gray-600">
        Organize API calls into logical groups for labeling, distillation, and fine-tuning.
      </p>
    </a>

    <a
      href="/docs/api-reference"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <BookOpen class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">API Reference</h2>
      </div>
      <p class="text-sm text-gray-600">
        Complete reference for all endpoints, parameters, headers, and error codes.
      </p>
    </a>

    <a
      href="/docs/code-examples"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Code class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Code Examples</h2>
      </div>
      <p class="text-sm text-gray-600">
        Practical examples in Python, JavaScript, and cURL for common use cases.
      </p>
    </a>

    <a
      href="/docs/sso"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <ShieldCheck class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Single Sign-On (SSO)</h2>
      </div>
      <p class="text-sm text-gray-600">
        Configure OIDC or SAML identity providers for your organization or instance.
      </p>
    </a>

    <a
      href="/docs/inference-drivers"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Cpu class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Inference Drivers</h2>
      </div>
      <p class="text-sm text-gray-600">
        Understand the differences between vLLM and Ollama, and choose the right driver for your deployments.
      </p>
    </a>

    <a
      href="/docs/deployment-troubleshooting"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Wrench class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Deployment Troubleshooting</h2>
      </div>
      <p class="text-sm text-gray-600">
        Diagnose and resolve common model deployment failures like GPU OOM, permission errors, and crash-loops.
      </p>
    </a>

    <a
      href="/docs/labeling-guide"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Tag class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Labeling Guide</h2>
      </div>
      <p class="text-sm text-gray-600">
        How to rate, highlight, edit, and curate your training data for best fine-tuning results.
      </p>
    </a>

    <a
      href="/docs/roles"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Users class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Roles & Permissions</h2>
      </div>
      <p class="text-sm text-gray-600">
        Understand what each role can do and how to manage team access within your organization.
      </p>
    </a>

    <a
      href="/docs/access-methods/"
      class="group block p-6 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
    >
      <div class="flex items-center gap-3 mb-3">
        <div class="p-2 rounded-lg bg-xinity-purple/10 text-xinity-purple group-hover:bg-xinity-purple/15 transition-colors">
          <Plug class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-semibold group-hover:text-xinity-purple transition-colors">Access Methods</h2>
      </div>
      <p class="text-sm text-gray-600">
        Four ways to interact with Xinity AI: dashboard UI, REST API, MCP server, and CLI.
      </p>
    </a>
  </div>
</div>
