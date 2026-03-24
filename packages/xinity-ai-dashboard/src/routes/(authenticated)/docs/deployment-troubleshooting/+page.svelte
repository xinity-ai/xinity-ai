<script lang="ts">
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { ChevronRight } from "@lucide/svelte";
</script>

<svelte:head>
  <title>Deployment Troubleshooting - Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <nav class="mb-6">
    <a
      href="/docs/"
      class="text-blue-600 hover:text-blue-800 flex items-center gap-2"
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

  <h1 class="mb-4 text-4xl font-bold">Deployment Troubleshooting</h1>
  <p class="mb-8 text-lg text-gray-600">
    Find the error message from your failed deployment below and follow the suggested fix.
  </p>

  <!-- Quick reference -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-2">When a deployment fails</h2>
    <p class="text-gray-600 mb-4">
      Go to the <a href="/modelhub" class="text-blue-600 hover:text-blue-800 underline">Model Hub</a>,
      find the failed deployment, and look at the <strong>error message</strong>.
      If available, expand <strong>View logs</strong> for more detail.
      Then match it to one of the patterns below.
    </p>
  </section>

  <!-- Error cards -->
  <div class="space-y-4 mb-8">

    <!-- GPU OOM -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 shrink-0">GPU</span>
        <div>
          <h3 class="text-lg font-semibold">GPU out of memory</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">CUDA out of memory</code>
            or <code class="bg-gray-100 px-1 rounded">OutOfMemoryError</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The model needs more GPU memory than is available on the node.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Reduce the <strong>KV cache size</strong> in Expert Settings when deploying.</li>
        <li>Choose a smaller or quantized version of the model.</li>
        <li>Deploy to a node with more VRAM.</li>
      </ul>
      <Collapsible.Root>
        <Collapsible.Trigger class="flex items-center gap-1 text-xs text-muted-foreground hover:underline cursor-pointer group">
          <ChevronRight class="w-3 h-3 transition-transform group-data-[state=open]:rotate-90" />
          Technical details
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div class="mt-3 p-3 bg-gray-50 rounded text-sm text-gray-600 space-y-2">
            <p>
              vLLM allocates GPU memory for both model weights and the KV cache at startup.
              If the combined allocation exceeds available VRAM, the process crashes immediately.
            </p>
            <p>
              The KV cache size can be configured per-deployment. Reducing it lowers memory usage
              but also reduces the number of concurrent requests the model can handle.
            </p>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </section>

    <!-- Triton Permission -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800 shrink-0">Permissions</span>
        <div>
          <h3 class="text-lg font-semibold">Triton cache permission error</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">PermissionError</code>
            together with <code class="bg-gray-100 px-1 rounded">triton</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The inference engine cannot write to its compilation cache directory.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Ask your system administrator to make the Triton cache directory writable.</li>
      </ul>
      <Collapsible.Root>
        <Collapsible.Trigger class="flex items-center gap-1 text-xs text-muted-foreground hover:underline cursor-pointer group">
          <ChevronRight class="w-3 h-3 transition-transform group-data-[state=open]:rotate-90" />
          Technical details
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div class="mt-3 p-3 bg-gray-50 rounded text-sm text-gray-600 space-y-2">
            <p>
              vLLM uses Triton to compile optimized GPU kernels on first use. These compiled
              kernels are cached in a directory (typically
              <code class="bg-gray-100 px-1 rounded">/var/lib/vllm/triton-cache</code>).
            </p>
            <p>
              For Docker deployments, the daemon creates this directory automatically with open
              permissions. If it still fails, the container UID may not match the directory owner.
              For systemd deployments, ensure the <code class="bg-gray-100 px-1 rounded">vllm</code>
              user has write access.
            </p>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </section>

    <!-- CUDA Runtime -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 shrink-0">GPU</span>
        <div>
          <h3 class="text-lg font-semibold">CUDA runtime error</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">RuntimeError: CUDA error</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        Something is wrong with the GPU or its drivers on the inference node.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Ask your system administrator to check the GPU drivers and restart the node.</li>
      </ul>
      <Collapsible.Root>
        <Collapsible.Trigger class="flex items-center gap-1 text-xs text-muted-foreground hover:underline cursor-pointer group">
          <ChevronRight class="w-3 h-3 transition-transform group-data-[state=open]:rotate-90" />
          Technical details
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div class="mt-3 p-3 bg-gray-50 rounded text-sm text-gray-600 space-y-2">
            <p>
              CUDA runtime errors are typically caused by GPU driver version mismatches, hardware
              faults, or corrupted GPU state. Run <code class="bg-gray-100 px-1 rounded">nvidia-smi</code>
              on the node to verify GPU accessibility. Restarting the node often clears transient GPU state issues.
            </p>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </section>

    <!-- Permission Errors -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800 shrink-0">Permissions</span>
        <div>
          <h3 class="text-lg font-semibold">Permission denied</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">PermissionError</code>
            or <code class="bg-gray-100 px-1 rounded">Permission denied</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The inference engine cannot access a file or directory it needs.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Ask your system administrator to check file permissions on the inference node.</li>
        <li>The logs will show exactly which path was inaccessible.</li>
      </ul>
      <Collapsible.Root>
        <Collapsible.Trigger class="flex items-center gap-1 text-xs text-muted-foreground hover:underline cursor-pointer group">
          <ChevronRight class="w-3 h-3 transition-transform group-data-[state=open]:rotate-90" />
          Technical details
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div class="mt-3 p-3 bg-gray-50 rounded text-sm text-gray-600 space-y-2">
            <p>
              Common paths that need to be writable: the HuggingFace model cache,
              the Triton compilation cache, and the vLLM environment config directory.
              For systemd deployments, ensure the
              <code class="bg-gray-100 px-1 rounded">vllm</code> user owns these directories.
            </p>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </section>

    <!-- Model Not Found -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 shrink-0">Config</span>
        <div>
          <h3 class="text-lg font-semibold">Model not found</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">does not appear to have a file named</code>
            or <code class="bg-gray-100 px-1 rounded">not found</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The system cannot find the model files. The model name may be wrong, or the
        download was incomplete.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Double-check the model name matches a valid model identifier.</li>
        <li>If the model is private, make sure authentication is configured.</li>
        <li>Try deleting and re-deploying to trigger a fresh download.</li>
      </ul>
    </section>

    <!-- Crash Loop -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-800 shrink-0">General</span>
        <div>
          <h3 class="text-lg font-semibold">Container crash-loop</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">crash-looping</code>
            and a restart count in the error message
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The model keeps starting and crashing repeatedly. The system stopped it after
        too many restarts.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Expand <strong>View logs</strong> in the Model Hub to find the real error.</li>
        <li>The root cause is usually one of the other errors on this page.</li>
        <li>Fix the underlying issue, then delete and re-create the deployment.</li>
      </ul>
    </section>
  </div>

  <!-- Reading Logs -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">How to read failure logs</h2>
    <p class="text-gray-600 mb-4">
      Failed deployments show a <strong>View logs</strong> section in the Model Hub.
      These are the last lines of output before the deployment was stopped.
    </p>
    <div class="space-y-3">
      <div class="flex items-start gap-3">
        <span class="mt-1 w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">1</span>
        <p class="text-gray-600"><strong>Start from the bottom.</strong> The most important error is usually in the last few lines.</p>
      </div>
      <div class="flex items-start gap-3">
        <span class="mt-1 w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">2</span>
        <p class="text-gray-600"><strong>Look for keywords</strong> like "Error", "Exception", or "FATAL".</p>
      </div>
      <div class="flex items-start gap-3">
        <span class="mt-1 w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">3</span>
        <p class="text-gray-600"><strong>Match to a pattern above.</strong> Copy the error text and search this page.</p>
      </div>
    </div>
  </section>

  <!-- Recovery -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">How to retry a failed deployment</h2>
    <p class="text-gray-600 mb-4">
      Failed deployments do not retry automatically. This prevents the system from
      repeatedly trying a broken configuration.
    </p>
    <ol class="list-decimal pl-6 space-y-2 text-gray-600">
      <li>Note down the error and check the failure logs (they are deleted with the deployment).</li>
      <li>Fix the underlying issue.</li>
      <li>Delete the failed deployment from the <a href="/modelhub" class="text-blue-600 hover:text-blue-800 underline">Model Hub</a>.</li>
      <li>Create a new deployment with the corrected settings.</li>
    </ol>
  </section>

  <!-- Related -->
  <section class="mb-8">
    <h2 class="text-xl font-semibold mb-4">Related Documentation</h2>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <a
        href="/docs/inference-drivers"
        class="group block p-4 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
      >
        <h3 class="font-semibold group-hover:text-blue-600 transition-colors">Inference Drivers</h3>
        <p class="text-sm text-gray-600">Understand the differences between vLLM and Ollama.</p>
      </a>
      <a
        href="/docs/quick-start"
        class="group block p-4 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
      >
        <h3 class="font-semibold group-hover:text-blue-600 transition-colors">Quick Start Guide</h3>
        <p class="text-sm text-gray-600">Deploy a model and make your first request.</p>
      </a>
    </div>
  </section>
</div>
