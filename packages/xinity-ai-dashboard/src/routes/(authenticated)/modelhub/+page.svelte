<script lang="ts">
  import type { PageData } from "./$types";
  import DeploymentModal from "./DeploymentModal.svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { invalidate } from "$app/navigation";
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
  import { Plus, Pencil, Trash2, Copy, Rocket } from "@lucide/svelte";
  import { browser } from "$app/environment";
  import { permissions } from "$lib/state/permissions.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import NoOrganization from "$lib/components/NoOrganization.svelte";

  let {data}: {
    data: PageData,
  } = $props();
  const maxNodeFreeCapacity = $derived(data.maxNodeFreeCapacity);
  const availableDrivers = $derived(data.availableDrivers);
  const nodeFreeCapacities = $derived(data.nodeFreeCapacities);

  let showCreateDeploymentModal = $state(false);
  let editDeploymentModalId: string | null = $state(null);
  let deploymentToDelete: (typeof data.deployments)[number] | null = $state(null);
  const editDeployment = $derived(data.deployments.find((d) => d.id === editDeploymentModalId))

  // Auto-refresh deployments
  $effect(() => {
    if (!browser) return;

    // Re-run this effect whenever data.deployments changes
    const deployments = data.deployments;

    const hasUnfinished = deployments.some(
      (d) =>
        // In-progress installation (downloading/installing)
        (d.status && d.status.phase !== "ready" && d.status.phase !== "failed") ||
        // Enabled deployment with no status yet (orchestration hasn't placed it)
        (d.enabled && !d.status),
    );

    // 10 seconds if any deployment is in progress, 1 hour otherwise
    const intervalDelay = hasUnfinished ? 10 :  60 * 60;

    const timer = setInterval(() => {
      invalidate("resource:deployments");
    }, intervalDelay * 1000);

    return () => clearInterval(timer);
  });

  function deploymentTypeLabel(deployment: (typeof data.deployments)[number]): string {
    // If there is no earlyModelSpecifier, it's a static single-model deployment
    if (!deployment?.earlyModelSpecifier) return "Static";

    // Canary deployments: determine sub-type
    if (deployment.canaryProgressWithFeedback) return "Canary (smart-auto)";
    if (deployment.canaryProgressUntil) return "Canary (time-based)";
    if (deployment.canaryProgressFrom) return "Canary (manual)";
    return "Canary";
  }

  async function handleEdit(id: string) {
    editDeploymentModalId = id;
  }

  function requestDelete(deployment: (typeof data.deployments)[number]) {
    deploymentToDelete = deployment;
  }

  async function confirmDelete() {
    if (!deploymentToDelete) return;
    const deleting = deploymentToDelete;
    deploymentToDelete = null;
    const deploymentsBefore = data.deployments;
    let failed = false;

    await updateOptimistically({
      apiPromise: () => orpc.deployment.delete({ id: deleting.id }),
      update: () => {
        data.deployments = data.deployments.filter((d) => d.id !== deleting.id);
      },
      undo: (error) => {
        data.deployments = deploymentsBefore;
        failed = true;
        browserLogger.warn(
          { error, deploymentId: deleting.id },
          "Failed to delete deployment",
        );
        toastState.add(`Failed to delete deployment`, "error");
      },
    });

    if (!failed) {
      toastState.add(`Deleted deployment "${deleting.name}"`, "success");
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

    {#if data.deployments.length > 0}
      <div class="grid grid-cols-1 gap-6 compact:gap-3 md:grid-cols-2 xl:grid-cols-3">
        {#each data.deployments as deployment (deployment.id)}
          <Card.Root
            data-deployment={JSON.stringify(deployment)}
            class={!deployment.enabled ? "border-l-4 border-l-destructive" : ""}
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

            <Card.Content class={["space-y-4 compact:space-y-2", !deployment.enabled && "opacity-60"].filter(Boolean).join(" ")}>
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

              {#if !deployment.enabled}
                <div>
                  <p class="text-sm text-muted-foreground mb-2">Status</p>
                  <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide uppercase bg-muted text-muted-foreground">
                    <span class="w-2 h-2 rounded-full bg-muted-foreground/50"></span>
                    Disabled
                  </span>
                </div>
              {:else if deployment.status}
                <div>
                  <p class="text-sm text-muted-foreground mb-2">Status</p>
                  {#if deployment.status.phase === 'ready'}
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide uppercase bg-[#4ade80]/15 text-[#16a34a]">
                      <span class="w-2 h-2 rounded-full bg-[#4ade80]"></span>
                      Ready
                    </span>
                  {:else if deployment.status.phase === 'failed'}
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide uppercase bg-destructive/15 text-destructive">
                      <span class="w-2 h-2 rounded-full bg-destructive"></span>
                      Failed
                    </span>
                  {:else if deployment.status.phase === 'scheduling'}
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide uppercase bg-[#98B9FD]/15 text-[#5b8ae6]">
                      <span class="w-2 h-2 rounded-full bg-[#98B9FD] animate-pulse"></span>
                      Scheduling
                    </span>
                  {:else}
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide uppercase bg-primary/15 text-primary">
                      <span class="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
                      {deployment.status.phase === 'downloading' ? 'Downloading' : 'Installing'}
                    </span>
                  {/if}
                  {#if deployment.status.progress != null}
                    <div class="w-full bg-muted rounded-full h-2 mt-2">
                      <div
                        class="bg-primary h-2 rounded-full transition-all"
                        style="width: {deployment.status.progress * 100}%"
                      ></div>
                    </div>
                  {/if}
                  {#if deployment.status.phase === 'failed' && deployment.status.error}
                    <p class="text-sm text-destructive mt-2">{deployment.status.error}</p>
                    <a href="/docs/deployment-troubleshooting" class="text-xs text-muted-foreground hover:underline mt-1 inline-block">
                      Troubleshooting guide
                    </a>
                  {/if}
                  {#if deployment.status.phase === 'failed' && deployment.status.failureLogs}
                    <Collapsible.Root class="mt-2">
                      <Collapsible.Trigger class="text-xs text-muted-foreground hover:underline cursor-pointer">
                        View logs
                      </Collapsible.Trigger>
                      <Collapsible.Content>
                        <pre class="mt-2 p-3 bg-muted rounded text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap wrap-break-word">{deployment.status.failureLogs}</pre>
                      </Collapsible.Content>
                    </Collapsible.Root>
                  {/if}
                </div>
              {/if}

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
                <Button variant="outline" size="sm" onclick={() => handleEdit(deployment.id)}>
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
            onclick={() => {
              showCreateDeploymentModal = true;
            }}
            class="flex flex-col items-center justify-center p-8 transition-colors border-2 border-dashed rounded-lg bg-muted/50 hover:bg-muted border-muted-foreground/25 hover:border-muted-foreground/50"
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
  {maxNodeFreeCapacity}
  {availableDrivers}
  {nodeFreeCapacities}
  close={() => (showCreateDeploymentModal = false)}
/>

{#if editDeployment}
  <DeploymentModal
    open={true}
    deployment={editDeployment}
    {maxNodeFreeCapacity}
    {availableDrivers}
    {nodeFreeCapacities}
    close={() => (editDeploymentModalId = null)}
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
