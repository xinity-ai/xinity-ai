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

  <h1 class="mb-4 text-4xl font-bold">Deployment Troubleshooting</h1>
  <p class="mb-8 text-lg text-gray-600">
    Find the error message from your failed deployment below and follow the suggested fix.
  </p>

  <!-- Quick reference -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-2">When a deployment fails</h2>
    <p class="text-gray-600 mb-4">
      Go to the <a href="/modelhub" class="text-xinity-magenta hover:text-xinity-pink underline">Model Hub</a>,
      find the failed deployment, and look at the <strong>error message</strong>.
      If available, expand <strong>View logs</strong> for more detail.
      Then match it to one of the patterns below.
    </p>
  </section>

  <!-- Error cards -->
  <div class="space-y-4 mb-8">

    <!-- GPU Memory Utilization Too High -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 shrink-0">GPU</span>
        <div>
          <h3 class="text-lg font-semibold">GPU memory utilization too high</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">Free memory on device ... is less than desired GPU memory utilization</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The configured GPU memory utilization percentage requires more VRAM than is
        currently free on the GPU. Other processes may be using some of the memory.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Lower the <strong>GPU memory utilization</strong> in Expert Settings (e.g. from 0.95 to 0.85).</li>
        <li>Stop other GPU processes on the node to free VRAM.</li>
        <li>Reduce the <strong>KV cache size</strong> to lower overall memory demand.</li>
      </ul>
      <Collapsible.Root>
        <Collapsible.Trigger class="flex items-center gap-1 text-xs text-muted-foreground hover:underline cursor-pointer group">
          <ChevronRight class="w-3 h-3 transition-transform group-data-[state=open]:rotate-90" />
          Technical details
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div class="mt-3 p-3 bg-gray-50 rounded text-sm text-gray-600 space-y-2">
            <p>
              vLLM's <code class="bg-gray-100 px-1 rounded">--gpu-memory-utilization</code> flag
              (default 0.90) tells it to claim a percentage of <em>total</em> GPU memory. If the
              free memory at startup is less than that amount (e.g. because the display driver or
              another process is using some), vLLM refuses to start rather than risk an OOM later.
            </p>
            <p>
              The error message shows exactly how much is free vs. how much was requested, making
              it easy to pick a lower value.
            </p>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </section>

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

    <!-- BFloat16 Not Supported -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 shrink-0">GPU</span>
        <div>
          <h3 class="text-lg font-semibold">GPU does not support bfloat16</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">Bfloat16 is not supported</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The GPU is too old to run this model's default data type (bfloat16 requires
        compute capability 8.0+, i.e. Ampere or newer).
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Add <code class="bg-gray-100 px-1 rounded">--dtype float16</code> to Extra Args in Expert Settings.</li>
        <li>Or deploy to a node with a newer GPU (Ampere / Ada / Hopper).</li>
      </ul>
    </section>

    <!-- CUDA/Driver Mismatch -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 shrink-0">GPU</span>
        <div>
          <h3 class="text-lg font-semibold">CUDA/driver version mismatch</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">NVIDIA driver on your system is too old</code>
            or <code class="bg-gray-100 px-1 rounded">unsupported toolchain</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The inference engine was built against a newer CUDA version than your GPU driver supports.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Update the NVIDIA driver on the inference node.</li>
        <li>Or use a vLLM image that matches the installed CUDA version.</li>
      </ul>
    </section>

    <!-- Invalid GPU Device -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 shrink-0">GPU</span>
        <div>
          <h3 class="text-lg font-semibold">Invalid GPU device index</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">CUDA error: invalid device ordinal</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The process is trying to use a GPU index that does not exist on this node.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Check that <code class="bg-gray-100 px-1 rounded">CUDA_VISIBLE_DEVICES</code> is set correctly.</li>
        <li>Ensure <code class="bg-gray-100 px-1 rounded">--tensor-parallel-size</code> does not exceed the number of GPUs.</li>
      </ul>
    </section>

    <!-- NVIDIA Runtime Missing -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800 shrink-0">Runtime</span>
        <div>
          <h3 class="text-lg font-semibold">NVIDIA container runtime missing</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">could not select device driver</code>
            or <code class="bg-gray-100 px-1 rounded">unknown or invalid runtime name: nvidia</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        Docker cannot access the GPU because the NVIDIA container toolkit is not installed.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Install <code class="bg-gray-100 px-1 rounded">nvidia-container-toolkit</code> on the node.</li>
        <li>Run <code class="bg-gray-100 px-1 rounded">nvidia-ctk runtime configure --runtime=docker</code> and restart Docker.</li>
      </ul>
    </section>

    <!-- NCCL Error -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800 shrink-0">Runtime</span>
        <div>
          <h3 class="text-lg font-semibold">NCCL communication error</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">ncclSystemError</code>
            or <code class="bg-gray-100 px-1 rounded">NCCL error</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        GPU-to-GPU communication failed during multi-GPU initialization.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Ensure Docker is running with <code class="bg-gray-100 px-1 rounded">--ipc=host</code> (the daemon does this automatically).</li>
        <li>Check that <code class="bg-gray-100 px-1 rounded">/dev/shm</code> is large enough (at least a few GB).</li>
        <li>Verify GPUs are not assigned to conflicting processes.</li>
      </ul>
    </section>

    <!-- Port Conflict -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800 shrink-0">Runtime</span>
        <div>
          <h3 class="text-lg font-semibold">Port already in use</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">Address already in use</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        Another process is already using the port assigned to this deployment.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Stop the conflicting process, or delete and re-deploy (a new port will be assigned).</li>
        <li>Check for zombie vLLM processes with <code class="bg-gray-100 px-1 rounded">lsof -i :&lt;port&gt;</code>.</li>
      </ul>
    </section>

    <!-- Unsupported Architecture -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-xinity-purple/15 text-xinity-pink shrink-0">Config</span>
        <div>
          <h3 class="text-lg font-semibold">Unsupported model architecture</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">Model architectures [...] are not supported</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        This model uses an architecture that the installed vLLM version does not support yet.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Upgrade to a newer vLLM version that supports this architecture.</li>
        <li>Or choose a model with a supported architecture.</li>
      </ul>
    </section>

    <!-- Context Length Too Large -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-xinity-purple/15 text-xinity-pink shrink-0">Config</span>
        <div>
          <h3 class="text-lg font-semibold">Configured context length too large</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">max_model_len ... is too large</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The requested maximum sequence length exceeds what the model supports or what fits in GPU memory.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Reduce <code class="bg-gray-100 px-1 rounded">--max-model-len</code> in Extra Args, or remove it to use the model's default.</li>
        <li>Deploy to a node with more VRAM if you need the full context window.</li>
      </ul>
    </section>

    <!-- HuggingFace Auth -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-xinity-purple/15 text-xinity-pink shrink-0">Config</span>
        <div>
          <h3 class="text-lg font-semibold">HuggingFace authentication required</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">Access to model ... is restricted</code>
            or <code class="bg-gray-100 px-1 rounded">gated repo</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The model is gated or private on HuggingFace and requires an access token.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Set the <code class="bg-gray-100 px-1 rounded">VLLM_HF_TOKEN</code> environment variable on the inference node.</li>
        <li>Make sure you have accepted the model's license on HuggingFace.</li>
      </ul>
    </section>

    <!-- Model Not Found -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-xinity-purple/15 text-xinity-pink shrink-0">Config</span>
        <div>
          <h3 class="text-lg font-semibold">Model files missing or not found</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">does not appear to have a file named</code>
            or <code class="bg-gray-100 px-1 rounded">does not exist on the Hub</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The system cannot find the model files. The model name may be wrong, or the
        download was incomplete.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Double-check the model name matches a valid HuggingFace model identifier.</li>
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

    <!-- Missing Shared Library -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-800 shrink-0">System</span>
        <div>
          <h3 class="text-lg font-semibold">Missing shared library</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">error while loading shared libraries</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        A required system library (CUDA, NCCL, etc.) is not installed or not in the library path.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Verify the CUDA toolkit and NVIDIA libraries are installed on the node.</li>
        <li>For Docker deployments, ensure the NVIDIA container runtime is configured.</li>
      </ul>
    </section>

    <!-- Insufficient Swap Space -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-800 shrink-0">System</span>
        <div>
          <h3 class="text-lg font-semibold">Insufficient CPU swap space</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">Aborted due to the lack of CPU swap space</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The system ran out of CPU swap space for request scheduling.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Increase the system swap space on the node.</li>
        <li>Reduce the number of concurrent sequences or swap space allocation.</li>
      </ul>
    </section>

    <!-- Engine Init Failed -->
    <section class="p-6 bg-white rounded-lg shadow-md">
      <div class="flex items-start gap-3 mb-3">
        <span class="mt-0.5 inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-800 shrink-0">General</span>
        <div>
          <h3 class="text-lg font-semibold">Engine initialization failed</h3>
          <p class="text-sm text-gray-500 mt-0.5">
            Look for: <code class="bg-gray-100 px-1 rounded">Engine core initialization failed</code>
          </p>
        </div>
      </div>
      <p class="text-gray-600 mb-3">
        The vLLM engine process crashed during startup. This is a wrapper error &mdash;
        the real cause is usually one of the other errors on this page.
      </p>
      <p class="text-sm font-semibold text-gray-700 mb-1">Likely fix:</p>
      <ul class="list-disc pl-6 space-y-1 text-sm text-gray-600 mb-3">
        <li>Expand <strong>View logs</strong> and scroll up to find the root cause error.</li>
        <li>Match the underlying error to another pattern on this page.</li>
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
        <span class="mt-1 w-6 h-6 rounded-full bg-xinity-purple/15 text-xinity-pink flex items-center justify-center text-xs font-bold shrink-0">1</span>
        <p class="text-gray-600"><strong>Start from the bottom.</strong> The most important error is usually in the last few lines.</p>
      </div>
      <div class="flex items-start gap-3">
        <span class="mt-1 w-6 h-6 rounded-full bg-xinity-purple/15 text-xinity-pink flex items-center justify-center text-xs font-bold shrink-0">2</span>
        <p class="text-gray-600"><strong>Look for keywords</strong> like "Error", "Exception", or "FATAL".</p>
      </div>
      <div class="flex items-start gap-3">
        <span class="mt-1 w-6 h-6 rounded-full bg-xinity-purple/15 text-xinity-pink flex items-center justify-center text-xs font-bold shrink-0">3</span>
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
      <li>Delete the failed deployment from the <a href="/modelhub" class="text-xinity-magenta hover:text-xinity-pink underline">Model Hub</a>.</li>
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
        <h3 class="font-semibold group-hover:text-xinity-purple transition-colors">Inference Drivers</h3>
        <p class="text-sm text-gray-600">Understand the differences between vLLM and Ollama.</p>
      </a>
      <a
        href="/docs/quick-start"
        class="group block p-4 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
      >
        <h3 class="font-semibold group-hover:text-xinity-purple transition-colors">Quick Start Guide</h3>
        <p class="text-sm text-gray-600">Deploy a model and make your first request.</p>
      </a>
    </div>
  </section>
</div>
