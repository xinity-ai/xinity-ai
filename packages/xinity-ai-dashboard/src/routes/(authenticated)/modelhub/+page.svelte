<script lang="ts">
  import type { PageData } from "./$types";
  import type { DeploymentDefinition } from "./+page.server";
  import { IDLE_REFRESH_MS, refreshEveryMs, viewOf } from "$lib/components/deployments/deployment-types";
  import { needsAttention, statusDisplayOf } from "$lib/components/deployments/status-display";
  import StatusChip from "$lib/components/deployments/StatusChip.svelte";
  import RolloutShare from "./RolloutShare.svelte";
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

  // Kept as a string so a refresh that leaves every pace as it was does not restart the timers.
  const paces = $derived(JSON.stringify(deployments.flatMap((d) => {
    const every = refreshEveryMs(d);
    return every === null ? [] : [{ id: d.id, every }];
  })));

  $effect(() => {
    if (!browser || !deploymentsLoaded) return;

    const byPace = Map.groupBy(JSON.parse(paces) as { id: string; every: number }[], ({ every }) => every);
    const timers = [...byPace].map(([every, entries]) => setInterval(async () => {
      await Promise.all(entries.map(async ({ id }) => {
        const [err, dep] = await orpc.deployments.get({ id, withStatus: true });
        if (!err && dep) {
          deployments = deployments.map((d) => (d.id === id ? dep : d));
        }
      }));
    }, every));

    return () => timers.forEach(clearInterval);
  });

  // Slow refresh of every deployment, for what changes in the cluster underneath
  $effect(() => {
    if (!browser || !deploymentsLoaded) return;

    const timer = setInterval(async () => {
      const [err, deps] = await orpc.deployments.list({ withStatus: true });
      if (err) { browserLogger.warn({ err }, "Background deployment refresh failed"); return; }
      deployments = deps;
    }, IDLE_REFRESH_MS);

    return () => clearInterval(timer);
  });


  const sortedDeployments = $derived(
    deployments.toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  );

  const summary = $derived.by(() => {
    const rollingOut = deployments.filter((d) => viewOf(d).rollingOut(d)).length;
    const attention = deployments.filter(needsAttention).length;
    return [
      { text: `${deployments.length} ${deployments.length === 1 ? "deployment" : "deployments"}`, warn: false },
      ...(rollingOut > 0 ? [{ text: `${rollingOut} rolling out`, warn: false }] : []),
      ...(attention > 0 ? [{ text: `${attention} ${attention === 1 ? "needs" : "need"} attention`, warn: true }] : []),
    ];
  });

  const readyReplicas = (deployment: DeploymentDefinition) =>
    deployment.status?.replicas?.filter((replica) => replica.phase === "ready").length ?? 0;
  const wantedReplicas = (deployment: DeploymentDefinition) =>
    deployment.status?.wanted.reduce((sum, { replicas }) => sum + replicas, 0) ?? viewOf(deployment).replicas(deployment);
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
              {#if index > 0}<span aria-hidden="true" class="mx-1.5">·</span><span class="sr-only">, </span>{/if}<span class={part.warn ? "text-amber-700 dark:text-amber-500" : ""}>{part.text}</span>
            {/each}
          {/if}
        </p>
      </div>
      {#if permissions.canManageDeployments}
        <Button href="/modelhub/new">
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
        <div class="hidden md:grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_10rem_5rem_1.5rem] gap-4 px-4 py-2 compact:px-3 compact:py-1 border-b text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span>Deployment</span>
          <span>Model</span>
          <span>Status</span>
          <span>Serving</span>
          <span></span>
        </div>
        <ul class="divide-y">
          {#each sortedDeployments as deployment (deployment.id)}
            {@const view = viewOf(deployment)}
            {@const models = view.models(deployment)}
            {@const badge = view.badge(deployment)}
            <li>
              <a
                href="/modelhub/{deployment.id}"
                class="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_10rem_5rem_1.5rem] items-center gap-x-4 gap-y-2 compact:gap-y-1 px-4 py-3 compact:px-3 compact:py-1.5 hover:bg-muted/50 transition-colors {deployment.enabled ? '' : 'opacity-60'}"
              >
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-medium truncate">{deployment.name}</span>
                    <span class="md:hidden"><StatusChip display={statusDisplayOf(deployment)} /></span>
                    {#if deployment.enabled}
                      <span class="text-xs text-muted-foreground md:hidden">{readyReplicas(deployment)} of {wantedReplicas(deployment)} serving</span>
                    {/if}
                    {#if badge}
                      <Badge variant="outline" class="shrink-0 {badge.class}">{badge.label}</Badge>
                    {/if}
                  </div>
                  <span class="block font-mono text-xs text-muted-foreground truncate">{deployment.publicSpecifier}</span>
                </div>
                <div class="min-w-0 space-y-1">
                  <div class="font-mono text-sm truncate" title={models.from ? `${models.from} → ${models.to}` : models.to}>
                    {#if models.from}
                      <span class="text-muted-foreground">{models.from} →</span>
                    {/if}
                    {models.to}
                  </div>
                  <RolloutShare {deployment} />
                </div>
                <div class="hidden md:block"><StatusChip display={statusDisplayOf(deployment)} /></div>
                <div class="hidden text-sm text-muted-foreground md:block" title="Replicas serving, of those wanted">
                  {deployment.enabled ? `${readyReplicas(deployment)} of ${wantedReplicas(deployment)}` : "Off"}
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
            <Button href="/modelhub/new">
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

