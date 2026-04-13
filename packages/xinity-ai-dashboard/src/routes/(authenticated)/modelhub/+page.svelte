<script lang="ts">
  import type { PageData } from "./$types";
  import type { DeploymentDefinition } from "./+page.server";
  import DeploymentModal from "./DeploymentModal.svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { humanDate, humanDuration, updateOptimistically } from "$lib/util";
  import { browserLogger } from "$lib/browserLogging";
  import { toastState } from "$lib/state/toast.svelte";
  import { copyToClipboard } from "$lib/copy";

  // shadcn components
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Badge } from "$lib/components/ui/badge";

  // Icons
  import { Plus, Pencil, Trash2, Copy, Rocket, Info } from "@lucide/svelte";
  import { browser } from "$app/environment";
  import { permissions } from "$lib/state/permissions.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import NoOrganization from "$lib/components/NoOrganization.svelte";

  let { data }: { data: PageData } = $props();
  let maxNodeFreeCapacity = $derived(data.maxNodeFreeCapacity);
  let availableDrivers = $derived(data.availableDrivers);
  let nodeFreeCapacities = $derived(data.nodeFreeCapacities);

  // Mutable overrides updated by refreshCapacity() after mutations.
  // When set, these take precedence over the load-function values.
  let capacityOverride = $state<{ maxNodeFreeCapacity: number; availableDrivers: string[]; nodeFreeCapacities: number[] } | null>(null);
  const activeMaxCapacity = $derived(capacityOverride?.maxNodeFreeCapacity ?? maxNodeFreeCapacity);
  const activeDrivers = $derived(capacityOverride?.availableDrivers ?? availableDrivers);
  const activeNodeCapacities = $derived(capacityOverride?.nodeFreeCapacities ?? nodeFreeCapacities);

  async function refreshCapacity() {
    const [err, cap] = await orpc.deployment.clusterCapacity({});
    if (!err && cap) capacityOverride = cap;
  }

  // ---------------------------------------------------------------------------
  // Local deployment state - driven by streamed initial load then updated in place
  // ---------------------------------------------------------------------------

  let deployments = $state<DeploymentDefinition[]>([]);
  let deploymentsLoaded = $state(false);
  let deletedIds = $state(new Set<string>());

  $effect(() => {
    Promise.resolve(data.deployments).then((deps) => {
      deployments = deps;
      deploymentsLoaded = true;
    });
  });

  function isUnclean(d: DeploymentDefinition): boolean {
    if (!d.enabled) return false;
    if (!d.status) return true; // enabled but no status reported yet = scheduling
    return d.status.phase !== "ready" && d.status.phase !== "failed";
  }

  // Fast refresh: only deployments with unclean status, every 10 seconds
  $effect(() => {
    if (!browser || !deploymentsLoaded) return;

    const uncleanIds = deployments
      .filter(d => !deletedIds.has(d.id) && isUnclean(d))
      .map(d => d.id);

    if (uncleanIds.length === 0) return;

    const timer = setInterval(async () => {
      await Promise.all(uncleanIds.map(async (id) => {
        const [err, dep] = await orpc.deployment.get({ id, withStatus: true });
        if (!err && dep) {
          deployments = deployments.map(d => d.id === id ? dep : d);
        }
      }));
    }, 10_000);

    return () => clearInterval(timer);
  });

  // Slow refresh: all deployments every 2 hours to catch any background changes
  $effect(() => {
    if (!browser || !deploymentsLoaded) return;

    const timer = setInterval(async () => {
      const [err, deps] = await orpc.deployment.list({ withStatus: true });
      if (err) { browserLogger.warn({ err }, "Background deployment refresh failed"); return; }
      deployments = deps;
    }, 2 * 60 * 60 * 1000);

    return () => clearInterval(timer);
  });

  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------

  let showCreateDeploymentModal = $state(false);
  let editDeploymentModalId: string | null = $state(null);
  let deploymentToDelete: DeploymentDefinition | null = $state(null);
  const editDeployment = $derived(deployments.find((d) => d.id === editDeploymentModalId));

  const visibleDeployments = $derived(
    deployments
      .filter(d => !deletedIds.has(d.id))
      .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  );

  function deploymentTypeLabel(deployment: DeploymentDefinition): string {
    if (!deployment?.earlyModelSpecifier) return "Static";
    if (deployment.canaryProgressWithFeedback) return "Canary (smart-auto)";
    if (deployment.canaryProgressUntil) return "Canary (time-based)";
    if (deployment.canaryProgressFrom) return "Canary (manual)";
    return "Canary";
  }

  function requestDelete(deployment: DeploymentDefinition) {
    deploymentToDelete = deployment;
  }

  async function refreshDeployments() {
    const [err, deps] = await orpc.deployment.list({ withStatus: true });
    if (err) {
      browserLogger.warn({ err }, "Failed to refresh deployments");
      toastState.add("Failed to refresh deployments", "error");
      return;
    }
    deployments = deps;
    refreshCapacity();
  }

  // Status chip colors/labels by phase
  const phaseConfig = {
    ready:       { dot: "bg-[#4ade80]",      chip: "bg-[#4ade80]/15 text-[#16a34a]",  pulse: false, label: "Ready" },
    failed:      { dot: "bg-destructive",     chip: "bg-destructive/15 text-destructive", pulse: false, label: "Failed" },
    scheduling:  { dot: "bg-[#98B9FD]",      chip: "bg-[#98B9FD]/15 text-[#5b8ae6]", pulse: true,  label: "Scheduling" },
    downloading: { dot: "bg-primary",         chip: "bg-primary/15 text-primary",      pulse: true,  label: "Downloading" },
    installing:  { dot: "bg-primary",         chip: "bg-primary/15 text-primary",      pulse: true,  label: "Installing" },
  } as const;

  async function confirmDelete() {
    if (!deploymentToDelete) return;
    const deleting = deploymentToDelete;
    deploymentToDelete = null;
    let failed = false;

    await updateOptimistically({
      apiPromise: () => orpc.deployment.delete({ id: deleting.id }),
      update: () => { deletedIds.add(deleting.id); },
      undo: (error) => {
        deletedIds.delete(deleting.id);
        failed = true;
        browserLogger.warn({ error, deploymentId: deleting.id }, "Failed to delete deployment");
        toastState.add(`Failed to delete deployment`, "error");
      },
    });

    if (!failed) {
      toastState.add(`Deleted deployment "${deleting.name}"`, "success");
      deployments = deployments.filter(d => d.id !== deleting.id);
      deletedIds.delete(deleting.id);
      refreshCapacity();
    }
  }
</script>

<svelte:head>
  <title>Model Hub - Xinity Admin Dashboard</title>
</svelte:head>

{#if !data.activeOrganizationId}
  <NoOrganization />
{:else}
  <div class="max-w-full p-6 compact:p-3">
    <div class="flex items-center justify-between mb-8 compact:mb-4">
      <div>
        <h1 class="mb-2 text-2xl font-bold">Model Hub</h1>
        <p class="text-muted-foreground">
          Manage and deploy your custom trained models
        </p>
      </div>
    </div>

    {#snippet chip(dotClass: string, chipClass: string, label: string, pulse = false, tooltip?: string)}
      <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide uppercase {chipClass}">
        <span class="w-2 h-2 rounded-full {dotClass} {pulse ? 'animate-pulse' : ''}"></span>
        {label}
        {#if tooltip}
          <span class="ml-0.5 cursor-help" title={tooltip}><Info class="w-3 h-3" /></span>
        {/if}
      </span>
    {/snippet}

    {#if !deploymentsLoaded}
      <!-- Skeleton cards while deployments stream in -->
      <div class="grid grid-cols-1 gap-6 compact:gap-3 md:grid-cols-2 xl:grid-cols-3">
        {#each [0, 1, 2] as _}
          <div class="rounded-lg border bg-card animate-pulse flex flex-col">
            <div class="p-6 pb-3">
              <div class="flex items-center justify-between">
                <div class="h-5 bg-muted rounded w-2/5"></div>
                <div class="h-5 bg-muted rounded w-16"></div>
              </div>
            </div>
            <div class="p-6 pt-0 space-y-5 flex-1">
              <div class="space-y-1.5">
                <div class="h-3 bg-muted rounded w-24"></div>
                <div class="h-5 bg-muted rounded w-3/4 font-mono"></div>
              </div>
              <div class="space-y-1.5">
                <div class="h-3 bg-muted rounded w-12"></div>
                <div class="h-7 bg-muted rounded-full w-20"></div>
              </div>
              <div class="space-y-1.5">
                <div class="h-3 bg-muted rounded w-14"></div>
                <div class="h-5 bg-muted rounded w-1/2"></div>
              </div>
              <div class="space-y-1.5">
                <div class="h-3 bg-muted rounded w-16"></div>
                <div class="h-5 bg-muted rounded w-2/3"></div>
              </div>
            </div>
            <div class="p-6 pt-4 border-t flex justify-end gap-2">
              <div class="h-9 bg-muted rounded w-16"></div>
              <div class="h-9 bg-muted rounded w-16"></div>
            </div>
          </div>
        {/each}
        {#if permissions.canManageDeployments}
          <button
            onclick={() => { showCreateDeploymentModal = true; }}
            class="flex flex-col items-center justify-center p-8 min-h-64 transition-colors border-2 border-dashed rounded-lg bg-muted/50 hover:bg-muted border-muted-foreground/25 hover:border-muted-foreground/50"
          >
            <Plus class="w-12 h-12 text-muted-foreground" />
            <p class="mt-2 text-lg font-medium text-muted-foreground">Deploy New Model</p>
          </button>
        {/if}
      </div>
    {:else if visibleDeployments.length > 0}
      <div class="grid grid-cols-1 gap-6 compact:gap-3 md:grid-cols-2 xl:grid-cols-3">
        {#each visibleDeployments as deployment (deployment.id)}
          <Card.Root
            data-deployment={JSON.stringify(deployment)}
            class={["flex flex-col", !deployment.enabled ? "border-l-4 border-l-destructive" : ""].filter(Boolean).join(" ")}
          >
            <Card.Header class={["pb-3", !deployment.enabled && "opacity-60"].filter(Boolean).join(" ")}>
              <div class="flex items-center justify-between">
                <Card.Title class="text-lg">{deployment.name}</Card.Title>
                <div class="flex items-center gap-2">
                  {#if !deployment.enabled}
                    <Badge variant="destructive">Disabled</Badge>
                  {/if}
                  {#if deployment.replicas > 1}
                    <Badge variant="secondary">{deployment.replicas} replicas</Badge>
                  {/if}
                  <Badge variant="outline">{deploymentTypeLabel(deployment)}</Badge>
                </div>
              </div>
            </Card.Header>

            <Card.Content class={["space-y-4 compact:space-y-2 flex-1", !deployment.enabled && "opacity-60"].filter(Boolean).join(" ")}>
              <div>
                <p class="text-sm text-muted-foreground">Model Specifier</p>
                <div class="flex items-center gap-2">
                  <p class="font-medium font-mono text-sm">{deployment.publicSpecifier}</p>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-7 w-7"
                    onclick={() => copyToClipboard(deployment.publicSpecifier)}
                    title="Copy model specifier"
                  >
                    <Copy class="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              <!-- Deployment Traffic Distribution -->
              {#if deployment.canaryProgressUntil}
                <div>
                  <p class="text-sm text-muted-foreground mb-2">Traffic Distribution</p>
                  <div class="w-full bg-muted rounded-full h-2">
                    <div
                      class="bg-primary h-2 rounded-full transition-all"
                      style="width: {deployment.progress}%"
                    ></div>
                  </div>
                  <div class="flex flex-wrap mt-1.5 text-xs text-muted-foreground">
                    <span>{deployment.progress}% to {deployment.publicSpecifier}</span>
                    {#if deployment.earlyModelSpecifier && 100 - deployment.progress > 0}
                      <span class="ml-auto">
                        {100 - deployment.progress}% to {deployment.earlyModelSpecifier}
                      </span>
                    {/if}
                  </div>
                </div>
              {/if}

              <div>
                <p class="text-sm text-muted-foreground mb-2">Status</p>
                {#if !deployment.enabled}
                  {@render chip("bg-muted-foreground/50", "bg-muted text-muted-foreground", "Disabled")}
                {:else if !deployment.status}
                  {@render chip("bg-amber-400", "bg-amber-100 text-amber-700", "No node available", false, "The orchestrator could not place this model on any node. Common causes: no node has enough free VRAM for the model weight, or no available node has the required driver.")}
                {:else}
                  {@const cfg = phaseConfig[deployment.status.phase]}
                  {@render chip(cfg.dot, cfg.chip, cfg.label, cfg.pulse)}
                  {#if deployment.status.progress != null}
                    <div title="{Math.round(deployment.status.progress * 100)}%" class="w-full bg-muted rounded-full h-2 mt-2">
                      <div class="bg-primary h-2 rounded-full transition-all" style="width: {deployment.status.progress * 100}%"></div>
                    </div>
                  {/if}
                  {#if deployment.status.phase === 'failed' && deployment.status.error}
                    <p class="text-sm text-destructive mt-2">{deployment.status.error}</p>
                    <a href="/docs/deployment-troubleshooting" class="text-xs text-muted-foreground hover:underline mt-1 inline-block">Troubleshooting guide</a>
                  {/if}
                  {#if deployment.status.phase === 'failed' && deployment.status.failureLogs}
                    <Collapsible.Root class="mt-2">
                      <Collapsible.Trigger class="text-xs text-muted-foreground hover:underline cursor-pointer">View logs</Collapsible.Trigger>
                      <Collapsible.Content>
                        <pre class="mt-2 p-3 bg-muted rounded text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap wrap-break-word">{deployment.status.failureLogs}</pre>
                      </Collapsible.Content>
                    </Collapsible.Root>
                  {/if}
                {/if}
              </div>

              <div>
                <p class="text-sm text-muted-foreground">Model</p>
                <p class="font-medium">{deployment.publicSpecifier}</p>
              </div>

              <div>
                <p class="text-sm text-muted-foreground">Created</p>
                <p class="font-medium">{humanDate(deployment.createdAt)}</p>
              </div>

              {#if (deployment.canaryProgressUntil?.valueOf() || 0) >= Date.now()}
                <div>
                  <p class="text-sm text-muted-foreground">Deployment Timeline</p>
                  <p class="font-medium">
                    Complete on {humanDate(deployment.canaryProgressUntil!)}
                  </p>
                </div>

                <div>
                  <p class="text-sm text-muted-foreground">Deployment Duration</p>
                  <p class="font-medium">
                    {(deployment.canaryProgressUntil &&
                      deployment.canaryProgressFrom &&
                      humanDuration(
                        (deployment.canaryProgressUntil.valueOf() -
                          deployment.canaryProgressFrom.valueOf()) /
                          1000 /
                          60 /
                          60,
                      )) ||
                      "N/A"}
                  </p>
                </div>
              {/if}
            </Card.Content>

            {#if permissions.canManageDeployments}
              <Card.Footer class="pt-4 border-t flex justify-end gap-2">
                <Button variant="outline" size="sm" onclick={() => (editDeploymentModalId = deployment.id)}>
                  <Pencil class="w-4 h-4" />
                  Edit
                </Button>
                <Button variant="destructive" size="sm" onclick={() => requestDelete(deployment)}>
                  <Trash2 class="w-4 h-4" />
                  Delete
                </Button>
              </Card.Footer>
            {/if}
          </Card.Root>
        {/each}

        {#if permissions.canManageDeployments}
          <button
            onclick={() => { showCreateDeploymentModal = true; }}
            class="flex flex-col items-center justify-center p-8 min-h-64 transition-colors border-2 border-dashed rounded-lg bg-muted/50 hover:bg-muted border-muted-foreground/25 hover:border-muted-foreground/50"
          >
            <Plus class="w-12 h-12 text-muted-foreground" />
            <p class="mt-2 text-lg font-medium text-muted-foreground">Deploy New Model</p>
          </button>
        {/if}
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
  maxNodeFreeCapacity={activeMaxCapacity}
  availableDrivers={activeDrivers}
  nodeFreeCapacities={activeNodeCapacities}
  close={() => (showCreateDeploymentModal = false)}
  onSaved={refreshDeployments}
/>

{#if editDeployment}
  <DeploymentModal
    open={true}
    deployment={editDeployment}
    maxNodeFreeCapacity={activeMaxCapacity}
    availableDrivers={activeDrivers}
    nodeFreeCapacities={activeNodeCapacities}
    close={() => (editDeploymentModalId = null)}
    onSaved={refreshDeployments}
  />
{/if}

<ConfirmDialog
  open={Boolean(deploymentToDelete)}
  title="Delete Deployment"
  description="Are you sure you want to delete {deploymentToDelete?.name ?? 'this deployment'}? This action cannot be undone."
  confirmLabel="Delete"
  onConfirm={() => void confirmDelete()}
  onCancel={() => (deploymentToDelete = null)}
/>
