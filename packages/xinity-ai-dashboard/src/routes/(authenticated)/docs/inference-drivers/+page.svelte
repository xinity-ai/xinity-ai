<svelte:head>
  <title>Inference Drivers - Documentation</title>
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

  <h1 class="mb-4 text-4xl font-bold">Inference Drivers</h1>
  <p class="mb-8 text-lg text-gray-600">
    Choose the right backend driver for your model deployments
  </p>

  <!-- What Are Inference Drivers -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">What Are Inference Drivers?</h2>
    <p class="text-gray-600 mb-4">
      When you deploy a model through Xinity, the system needs a backend engine to load
      the model into memory and serve inference requests. This engine is called the
      <strong>inference driver</strong>. As a user, you interact exclusively with the
      Xinity API gateway, the driver runs behind the scenes on your inference nodes.
    </p>
    <p class="text-gray-600">
      Xinity supports two inference drivers: <strong>vLLM</strong> and <strong>Ollama</strong>.
      Both are deployed and managed automatically by the system. The deployment experience is the
      same regardless of which driver you choose, the difference lies in how the model
      runs on the hardware.
    </p>
  </section>

  <!-- vLLM -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">vLLM</h2>
    <p class="text-gray-600 mb-4">
      vLLM is a high-performance inference engine optimized for throughput and efficient GPU
      memory management. It is the recommended driver for production workloads.
    </p>

    <h3 class="text-lg font-semibold mb-3 text-green-700">Advantages</h3>
    <ul class="list-disc pl-6 space-y-2 text-gray-600 mb-6">
      <li>
        <strong>Significantly faster inference</strong>, Optimized request processing
        delivers noticeably lower latency per request.
      </li>
      <li>
        <strong>High concurrency</strong>, Continuous batching allows many simultaneous
        requests without significant performance degradation.
      </li>
      <li>
        <strong>Efficient memory management</strong>, PagedAttention enables more
        concurrent requests on the same hardware.
      </li>
      <li>
        <strong>Multi-GPU support</strong>, Can split larger models across multiple GPUs
        via tensor parallelism.
      </li>
      <li>
        <strong>Higher stability</strong>, Designed for sustained, long-running production workloads.
      </li>
    </ul>

    <h3 class="text-lg font-semibold mb-3 text-red-700">Trade-offs</h3>
    <ul class="list-disc pl-6 space-y-2 text-gray-600">
      <li>
        <strong>Longer startup time</strong>, Model loading takes longer due to
        the more complex initialization process. Expect minutes rather than seconds
        before the deployment is ready.
      </li>
      <li>
        <strong>Permanent memory occupation</strong>, The model remains loaded in
        GPU memory for the entire lifetime of the deployment, even when idle.
      </li>
      <li>
        <strong>Slightly higher energy usage</strong>, Because memory stays allocated
        while idle, power consumption is marginally higher than Ollama during low-traffic periods.
      </li>
    </ul>
  </section>

  <!-- Ollama -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Ollama</h2>
    <p class="text-gray-600 mb-4">
      Ollama is a lightweight model runner that trades raw performance for flexibility
      and lower resource consumption during idle periods.
    </p>

    <h3 class="text-lg font-semibold mb-3 text-green-700">Advantages</h3>
    <ul class="list-disc pl-6 space-y-2 text-gray-600 mb-6">
      <li>
        <strong>Frees memory when idle</strong>, Does not permanently occupy machine memory.
        Resources are released when the model is not actively processing requests.
      </li>
      <li>
        <strong>Lower energy consumption</strong>, Because memory is not held during idle
        periods, power usage is lower when traffic is intermittent.
      </li>
      <li>
        <strong>Fast startup</strong>, Models become ready to serve requests more quickly
        after deployment.
      </li>
    </ul>

    <h3 class="text-lg font-semibold mb-3 text-red-700">Trade-offs</h3>
    <ul class="list-disc pl-6 space-y-2 text-gray-600">
      <li>
        <strong>Slower inference</strong>, Request processing is noticeably slower
        compared to vLLM, especially under load.
      </li>
      <li>
        <strong>Lower stability under load</strong>, Performance degrades more
        steeply when handling many concurrent requests.
      </li>
      <li>
        <strong>Limited batching</strong>, Lacks continuous batching, which limits
        efficiency with many simultaneous requests.
      </li>
      <li>
        <strong>Single-GPU only</strong>, Cannot split models across multiple GPUs.
      </li>
    </ul>
  </section>

  <!-- Comparison Table -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Comparison</h2>
    <div class="overflow-x-auto">
      <table class="w-full text-left">
        <thead>
          <tr class="border-b-2 border-gray-200">
            <th class="py-3 pr-4 font-semibold text-gray-700"></th>
            <th class="py-3 pr-4 font-semibold text-gray-700">vLLM</th>
            <th class="py-3 font-semibold text-gray-700">Ollama</th>
          </tr>
        </thead>
        <tbody class="text-gray-600">
          <tr class="border-b border-gray-100">
            <td class="py-3 pr-4 font-medium">Inference speed</td>
            <td class="py-3 pr-4">Fast</td>
            <td class="py-3">Slower</td>
          </tr>
          <tr class="border-b border-gray-100">
            <td class="py-3 pr-4 font-medium">Concurrency</td>
            <td class="py-3 pr-4">Excellent</td>
            <td class="py-3">Limited</td>
          </tr>
          <tr class="border-b border-gray-100">
            <td class="py-3 pr-4 font-medium">Stability under load</td>
            <td class="py-3 pr-4">High</td>
            <td class="py-3">Moderate</td>
          </tr>
          <tr class="border-b border-gray-100">
            <td class="py-3 pr-4 font-medium">Startup time</td>
            <td class="py-3 pr-4">Minutes</td>
            <td class="py-3">Seconds</td>
          </tr>
          <tr class="border-b border-gray-100">
            <td class="py-3 pr-4 font-medium">Memory when idle</td>
            <td class="py-3 pr-4">Occupied permanently</td>
            <td class="py-3">Released</td>
          </tr>
          <tr class="border-b border-gray-100">
            <td class="py-3 pr-4 font-medium">Energy usage</td>
            <td class="py-3 pr-4">Slightly higher</td>
            <td class="py-3">Lower</td>
          </tr>
          <tr class="border-b border-gray-100">
            <td class="py-3 pr-4 font-medium">Multi-GPU</td>
            <td class="py-3 pr-4">Yes (tensor parallelism)</td>
            <td class="py-3">No</td>
          </tr>
          <tr>
            <td class="py-3 pr-4 font-medium">Best for</td>
            <td class="py-3 pr-4">Production, high-traffic</td>
            <td class="py-3">Low-traffic, CPU-only nodes</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- How Auto Works -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">How "Auto" Works</h2>
    <p class="text-gray-600 mb-4">
      When the preferred driver is set to <strong>Auto</strong> (the default), the system selects
      the best available driver automatically:
    </p>
    <ol class="list-decimal pl-6 space-y-2 text-gray-600 mb-4">
      <li>
        <strong>vLLM is preferred</strong> when available, as it provides better performance
        for most workloads.
      </li>
      <li>
        <strong>Ollama is used as a fallback</strong> when vLLM is not available for the model
        or when no vLLM-capable nodes exist in the cluster.
      </li>
      <li>
        Only drivers that are both <strong>supported by the model</strong> and <strong>available
        on cluster nodes</strong> with sufficient capacity are considered.
      </li>
    </ol>
    <div class="p-4 bg-xinity-purple/10 border-l-4 border-xinity-purple text-gray-700">
      <strong>Tip:</strong> Auto is the recommended setting for most deployments. Only override it
      if you have a specific reason to prefer one driver over the other, for example, choosing
      Ollama to reduce idle energy consumption on a low-traffic deployment, or forcing vLLM for a
      latency-sensitive workload.
    </div>
  </section>

  <!-- How to Set the Driver -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">How to Set the Driver</h2>
    <p class="text-gray-600 mb-4">
      You can set the preferred driver when creating or editing a deployment:
    </p>
    <ol class="list-decimal pl-6 space-y-3 text-gray-600">
      <li>Navigate to the <a href="/modelhub" class="text-xinity-magenta hover:text-xinity-pink underline">Model Hub</a>.</li>
      <li>Click <strong>Deploy New Model</strong> or <strong>Edit</strong> on an existing deployment.</li>
      <li>Open the <strong>Expert Settings</strong> section.</li>
      <li>Select your preferred driver from the <strong>Preferred Driver</strong> dropdown.</li>
      <li>Click <strong>Deploy</strong> or <strong>Save</strong> to apply.</li>
    </ol>
  </section>

  <!-- Related -->
  <section class="mb-8">
    <h2 class="text-xl font-semibold mb-4">Related Documentation</h2>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <a
        href="/docs/quick-start"
        class="group block p-4 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
      >
        <h3 class="font-semibold group-hover:text-xinity-purple transition-colors">Quick Start Guide</h3>
        <p class="text-sm text-gray-600">Deploy a model and make your first request.</p>
      </a>
      <a
        href="/docs/api-reference"
        class="group block p-4 bg-white border rounded-lg shadow-sm hover:shadow-md transition"
      >
        <h3 class="font-semibold group-hover:text-xinity-purple transition-colors">API Reference</h3>
        <p class="text-sm text-gray-600">Complete reference for all endpoints and parameters.</p>
      </a>
    </div>
  </section>
</div>
