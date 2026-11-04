<script lang="ts">
  import type { PageData } from "./$types";
  import type { DeploymentDefinition } from "./+page.server";
  import { invalidate } from "$app/navigation";
  import DeploymentModal from "./DeploymentModal.svelte";
  import { viewOf } from "./deployment-types";
  import { isSettling, needsAttention, statusDisplayOf } from "$lib/components/deployments/status-display";
  import StatusChip from "$lib/components/deployments/StatusChip.svelte";
  import TrafficSplit from "$lib/components/deployments/TrafficSplit.svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { browserLogger } from "$lib/browserLogging";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { Plus, Rocket, ArrowRight } from "@lucide/svelte";
  import { browser } from "$app/env";
  import { permissions } from "$lib/state/permissions.svelte";
  import NoOrganization from "$lib/components/NoOrganization.svelte";

  let { data }: { data: PageData } = $props();

  let deployments = $state<DeploymentDefinition[]>([]);
  let deploymentsLoaded = $state(false);

  $effect(() => {
    Promise.resolve(data.deployments).then((deps) => {
      deployments = deps;
      deploymentsLoaded = true;
    });
  });

  // Fast refresh: only deployments still settling, every 10 seconds
  $effect(() => {
    if (!browser || !deploymentsLoaded) return;

    const settlingIds = deployments.filter(isSettling).map((d) => d.id);
    if (settlingIds.length === 0) return;

    const timer = setInterval(async () => {
      await Promise.all(settlingIds.map(async (id) => {
        const [err, dep] = await orpc.deployments.get({ id, withStatus: true });
        if (!err && dep) {
          deployments = deployments.map((d) => (d.id === id ? dep : d));
        }
      }));
    }, 10_000);

    return () => clearInterval(timer);
  });

  // Slow refresh: all deployments every 2 hours to catch any background changes
  $effect(() => {
    if (!browser || !deploymentsLoaded) return;

    const timer = setInterval(async () => {
      const [err, deps] = await orpc.deployments.list({ withStatus: true });
      if (err) { browserLogger.warn({ err }, "Background deployment refresh failed"); return; }
      deployments = deps;
    }, 2 * 60 * 60 * 1000);

    return () => clearInterval(timer);
  });

  let showCreateDeploymentModal = $state(false);

  const sortedDeployments = $derived(
    deployments.toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  );

  const summary = $derived.by(() => {
    const rollingOut = deployments.filter((d) => viewOf(d).traffic(d) !== null).length;
    const attention = deployments.filter(needsAttention).length;
    return [
      { text: `${deployments.length} ${deployments.length === 1 ? "deployment" : "deployments"}`, warn: false },
      ...(rollingOut > 0 ? [{ text: `${rollingOut} rolling out`, warn: false }] : []),
      ...(attention > 0 ? [{ text: `${attention} ${attention === 1 ? "needs" : "need"} attention`, warn: true }] : []),
    ];
  });

  const readyReplicas = (deployment: DeploymentDefinition) =>
    deployment.status?.replicas?.filter((replica) => replica.phase === "ready").length ?? 0;
</script>

<svelte:head>
  <title>Model Hub - Xinity Admin Dashboard</title>
</svelte:head>

{#if !data.activeOrganizationId}
  <NoOrganization />
{:else}
  <div class="max-w-full p-6 compact:p-3">
    <div class="flex flex-wrap items-end justify-between gap-4 mb-6 compact:mb-3">
      <div>
        <h1 class="mb-2 text-2xl font-bold">Model Hub</h1>
        <p class="text-muted-foreground">
          {#if !deploymentsLoaded}
            Loading deployments…
          {:else}
            {#each summary as part, index (part.text)}
              {#if index > 0}<span aria-hidden="true"> · </span>{/if}<span class={part.warn ? "text-amber-700 dark:text-amber-500" : ""}>{part.text}</span>
            {/each}
          {/if}
        </p>
      </div>
      {#if permissions.canManageDeployments}
        <Button onclick={() => { showCreateDeploymentModal = true; }}>
          <Plus class="w-4 h-4" />
          Deploy New Model
        </Button>
      {/if}
    </div>

    {#if !deploymentsLoaded}
      <div class="rounded-lg border bg-card divide-y animate-pulse">
        {#each [0, 1, 2] as _}
          <div class="flex items-center gap-6 px-4 py-4">
            <div class="h-5 bg-muted rounded w-48"></div>
            <div class="h-4 bg-muted rounded w-40"></div>
            <div class="h-6 bg-muted rounded-full w-20 ml-auto"></div>
          </div>
        {/each}
      </div>
    {:else if sortedDeployments.length > 0}
      <div class="rounded-lg border bg-card">
        <div class="hidden md:grid grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto_5rem_minmax(0,1fr)_1.5rem] gap-4 px-4 py-2 border-b text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span>Deployment</span>
          <span>Model</span>
          <span>Status</span>
          <span>Replicas</span>
          <span>Traffic</span>
          <span></span>
        </div>
        <ul class="divide-y">
          {#each sortedDeployments as deployment (deployment.id)}
            {@const view = viewOf(deployment)}
            {@const models = view.models(deployment)}
            {@const traffic = view.traffic(deployment)}
            {@const badge = view.badge(deployment)}
            <li>
              <a
                href="/modelhub/{deployment.id}"
                class="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto_5rem_minmax(0,1fr)_1.5rem] items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-muted/50 transition-colors {deployment.enabled ? '' : 'opacity-60'}"
              >
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-medium truncate">{deployment.name}</span>
                    {#if badge}
                      <Badge variant="outline" class="shrink-0">{badge}</Badge>
                    {/if}
                  </div>
                  <span class="block font-mono text-xs text-muted-foreground truncate">{deployment.publicSpecifier}</span>
                </div>
                <div class="min-w-0 font-mono text-sm truncate" title={models.from ? `${models.from} → ${models.to}` : models.to}>
                  {#if models.from}
                    <span class="text-muted-foreground">{models.from} →</span>
                  {/if}
                  {models.to}
                </div>
                <div><StatusChip display={statusDisplayOf(deployment)} /></div>
                <div class="text-sm text-muted-foreground" title="Ready of requested replicas">
                  {deployment.enabled ? `${readyReplicas(deployment)}/${view.replicas(deployment)}` : view.replicas(deployment)}
                </div>
                <div>
                  {#if traffic !== null}
                    <TrafficSplit share={traffic} />
                    <span class="text-xs text-muted-foreground">{traffic}% to the new model</span>
                  {/if}
                </div>
                <ArrowRight class="hidden md:block w-4 h-4 text-muted-foreground" />
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <Card.Root class="mt-6">
        <Card.Content class="flex flex-col items-center justify-center py-12">
          <div class="flex items-center justify-center w-16 h-16 mb-4 rounded-full bg-muted">
            <Rocket class="w-8 h-8 text-muted-foreground" />
          </div>
          <p class="text-lg text-muted-foreground mb-4">
            There are no model deployments as of yet.
          </p>
          {#if permissions.canManageDeployments}
            <Button onclick={() => { showCreateDeploymentModal = true; }}>
              <Plus class="w-4 h-4" />
              Deploy Your First Model
            </Button>
          {:else}
            <p class="text-sm text-muted-foreground">
              Contact an organization admin to deploy a model.
            </p>
          {/if}
        </Card.Content>
      </Card.Root>
    {/if}
  </div>
{/if}

<DeploymentModal
  open={showCreateDeploymentModal}
  nodeCapabilities={data.cluster.nodeCapabilities}
  modelCompatibility={data.cluster.modelCompatibility}
  close={() => (showCreateDeploymentModal = false)}
  onSaved={() => invalidate("resource:cluster")}
/>
