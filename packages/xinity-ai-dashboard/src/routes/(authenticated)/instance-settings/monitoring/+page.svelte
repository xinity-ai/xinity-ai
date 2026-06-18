<script lang="ts">
  import type { PageData } from "./$types";
  import { copyToClipboard } from "$lib/copy";
  import { Copy, Check } from "@lucide/svelte";

  let { data }: { data: PageData } = $props();

  let copied = $state(false);

  // Prometheus defaults to http; only emit a scheme line when the target is https.
  const schemeLine = (scheme: string) => (scheme === "https" ? ["    scheme: https"] : []);

  const commentedAuth = (pad: string, label: string) => [
    `${pad}# ${label}`,
    `${pad}# basic_auth:`,
    `${pad}#   username: <user>`,
    `${pad}#   password: <password>`,
  ];

  // The dashboard's METRICS_AUTH is required, so the block is active; the operator
  // fills in the credential they configured (it is not rendered server-side).
  const dashboardAuth = (pad: string) => [
    `${pad}# Replace with the dashboard's METRICS_AUTH credential (required):`,
    `${pad}basic_auth:`,
    `${pad}  username: <METRICS_AUTH user>`,
    `${pad}  password: <METRICS_AUTH password>`,
  ];

  function buildPrometheusYml(): string {
    return [
      "global:",
      "  scrape_interval: 30s",
      "  evaluation_interval: 30s",
      "",
      "scrape_configs:",
      "  - job_name: xinity-gateway",
      "    metrics_path: /metrics",
      ...schemeLine(data.gatewayScheme),
      "    static_configs:",
      "      - targets:",
      `          - ${data.gatewayTarget}`,
      ...commentedAuth("    ", "Uncomment if the gateway has METRICS_AUTH set:"),
      "",
      "  - job_name: xinity-dashboard",
      "    metrics_path: /metrics",
      ...schemeLine(data.dashboardScheme),
      "    static_configs:",
      "      - targets:",
      `          - ${data.dashboardTarget}`,
      ...dashboardAuth("    "),
      "",
      "  # Daemon targets are discovered dynamically from the dashboard's node",
      "  # registry, so this never needs editing as the fleet changes.",
      "  - job_name: xinity-daemon",
      "    metrics_path: /metrics",
      "    http_sd_configs:",
      `      - url: ${data.daemonSdUrl}`,
      "        refresh_interval: 3m",
      ...dashboardAuth("        "),
      ...commentedAuth("    ", "Uncomment if the daemons have METRICS_AUTH set:"),
    ].join("\n");
  }

  const prometheusYml = $derived(buildPrometheusYml());

  async function handleCopy() {
    copyToClipboard(prometheusYml);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }
</script>

<svelte:head>
  <title>Monitoring · Xinity</title>
</svelte:head>

<div class="space-y-6">
  <div>
    <h2 class="text-xl font-semibold">Prometheus Configuration</h2>
    <p class="text-sm text-muted-foreground mt-1">
      Copy this into your
      <code class="font-mono text-xs bg-muted px-1 py-0.5 rounded">prometheus.yml</code>.
      The gateway and dashboard targets are derived from this deployment's configured URLs;
      adjust them if your Prometheus reaches the services on different addresses (e.g. internal
      hostnames when co-located). Daemon targets are discovered dynamically, so that job tracks
      the fleet without edits.
    </p>
  </div>

  <div class="relative rounded-lg border bg-muted/40 overflow-hidden">
    <div class="flex items-center justify-between px-4 py-2 border-b bg-muted/60">
      <span class="text-xs font-mono text-muted-foreground">prometheus.yml</span>
      <button
        onclick={handleCopy}
        class="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
        aria-label="Copy to clipboard"
      >
        {#if copied}
          <Check class="w-3.5 h-3.5 text-emerald-500" />
          <span class="text-emerald-500">Copied</span>
        {:else}
          <Copy class="w-3.5 h-3.5" />
          Copy
        {/if}
      </button>
    </div>
    <pre class="p-4 text-sm font-mono overflow-x-auto leading-relaxed text-foreground/90">{prometheusYml}</pre>
  </div>

  <div class="rounded-lg border p-4 space-y-3 text-sm">
    <h3 class="font-medium">Docker Compose setup</h3>
    <p class="text-muted-foreground">
      The deployment includes a <code class="font-mono text-xs bg-muted px-1 py-0.5 rounded">monitoring</code> profile
      that starts Prometheus and Grafana pre-wired to the gateway and dashboard. Run:
    </p>
    <pre class="bg-muted rounded p-3 text-xs font-mono">docker compose --profile monitoring up -d</pre>
    <p class="text-muted-foreground">
      The bundled <code class="font-mono text-xs bg-muted px-1 py-0.5 rounded">deployment/docker/monitoring/prometheus.yml</code>
      already discovers daemon targets from this dashboard, so no per-node edits or reloads are
      needed as the fleet changes.
    </p>
  </div>

  <div class="rounded-lg border p-4 space-y-3 text-sm">
    <h3 class="font-medium">Fleet metrics overlay</h3>
    <p class="text-muted-foreground">
      Set <code class="font-mono text-xs bg-muted px-1 py-0.5 rounded">PROMETHEUS_URL</code> in the dashboard
      environment to enable live GPU utilization and energy readings on the Compute fleet page.
    </p>
    <pre class="bg-muted rounded p-3 text-xs font-mono">PROMETHEUS_URL=http://prometheus:9090</pre>
    <p class="text-muted-foreground">
      The Compute page remains fully functional without Prometheus. The overlay appears automatically
      once the daemon nodes have reported at least one GPU sample.
    </p>
  </div>

  {#if data.nodeCount === 0}
    <div class="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      No daemon nodes are registered yet. The
      <code class="font-mono text-xs px-1">xinity-daemon</code> discovery endpoint will return an
      empty list until nodes come online; Prometheus picks them up automatically once they do.
    </div>
  {/if}
</div>
