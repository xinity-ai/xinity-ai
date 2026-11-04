<script lang="ts">
  import { browser } from "$app/env";
  import { goto, invalidate } from "$app/navigation";
  import { ArrowLeft, Copy, MessageSquare, Pencil, RotateCcw, Trash2 } from "@lucide/svelte";
  import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
  import { orpc } from "$lib/orpc/orpc-client";
  import { copyToClipboard } from "$lib/copy";
  import { humanDate } from "$lib/util";
  import { toastState } from "$lib/state/toast.svelte";
  import { permissions } from "$lib/state/permissions.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Switch } from "$lib/components/ui/switch";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import NoOrganization from "$lib/components/NoOrganization.svelte";
  import type { PageData } from "./$types";
  import { viewOf } from "../deployment-types";
  import { isServing, isSettling, statusDisplayOf } from "$lib/components/deployments/status-display";
  import ReplicaStatus from "./ReplicaStatus.svelte";
  import StatusChip from "$lib/components/deployments/StatusChip.svelte";
  import TestChatModal from "./TestChatModal.svelte";
  import TestEmbeddingModal from "./TestEmbeddingModal.svelte";
  import TestRerankModal from "./TestRerankModal.svelte";

  let { data }: { data: PageData } = $props();

  // Polling and actions replace what the load returned, until the next navigation loads afresh.
  let refreshed = $state<DeploymentOutput | null>(null);
  const deployment = $derived(refreshed && refreshed.id === data.deployment?.id ? refreshed : data.deployment);

  let editing = $state(false);
  let confirmingDelete = $state(false);
  let testing = $state(false);
  let togglingEnabled = $state(false);
  let testableType = $state<"chat" | "embedding" | "rerank" | null>(null);

  async function refresh() {
    if (!deployment) {
      return;
    }
    const [err, latest] = await orpc.deployments.get({ id: deployment.id, withStatus: true });
    if (!err) {
      refreshed = latest;
    }
  }

  async function reload() {
    await invalidate("resource:cluster");
    refreshed = null;
  }

  $effect(() => {
    if (!browser || !deployment || !isSettling(deployment)) {
      return;
    }
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    if (!deployment || !isServing(deployment)) {
      return;
    }
    const specifier = viewOf(deployment).models(deployment).to;
    void orpc.model.get({ specifier }).then(([err, model]) => {
      const type = err || !model ? undefined : model.type ?? "chat";
      testableType = type === "chat" || type === "embedding" || type === "rerank" ? type : null;
    });
  });

  async function setEnabled(enabled: boolean) {
    if (!deployment) {
      return;
    }
    togglingEnabled = true;
    const [err] = await orpc.deployments.enable({ id: deployment.id, enabled });
    togglingEnabled = false;
    if (err) {
      toastState.add(`Failed to ${enabled ? "enable" : "disable"} the deployment: ${err.message}`, "error");
    }
    await refresh();
  }

  async function retry() {
    if (!deployment) {
      return;
    }
    const [err] = await orpc.deployments.retry({ id: deployment.id });
    if (err) {
      toastState.add("Failed to retry deployment", "error");
      return;
    }
    toastState.add(`Retrying "${deployment.name}"`, "success");
    await refresh();
  }

  async function confirmDelete() {
    confirmingDelete = false;
    if (!deployment) {
      return;
    }
    const [err] = await orpc.deployments.delete({ id: deployment.id });
    if (err) {
      toastState.add("Failed to delete deployment", "error");
      return;
    }
    toastState.add(`Deleted deployment "${deployment.name}"`, "success");
    await goto("/modelhub/");
  }
</script>

<svelte:head>
  <title>{deployment?.name ?? "Deployment"} - Model Hub - Xinity Admin Dashboard</title>
</svelte:head>

{#if !deployment}
  <NoOrganization />
{:else}
  {@const view = viewOf(deployment)}
  {@const badge = view.badge(deployment)}
  {@const Panel = view.panel}
  <div class="max-w-5xl p-6 compact:p-3 space-y-6 compact:space-y-3">
    <a href="/modelhub/" class="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft class="w-4 h-4" />
      Model Hub
    </a>

    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="space-y-1.5 min-w-0">
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="text-2xl font-bold truncate">{deployment.name}</h1>
          <StatusChip display={statusDisplayOf(deployment)} />
          {#if badge}
            <Badge variant="outline">{badge}</Badge>
          {/if}
        </div>
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Called as</span>
          <span class="font-mono text-foreground">{deployment.publicSpecifier}</span>
          <Button variant="ghost" size="icon" class="h-6 w-6" onclick={() => copyToClipboard(deployment.publicSpecifier)} title="Copy the name to call it by">
            <Copy class="w-3 h-3" />
          </Button>
        </div>
        {#if deployment.description}
          <p class="text-sm text-muted-foreground">{deployment.description}</p>
        {/if}
      </div>
      <div class="flex flex-wrap items-center gap-3">
        {#if isServing(deployment) && testableType}
          <Button variant="outline" onclick={() => (testing = true)}>
            <MessageSquare class="w-4 h-4" />
            Test
          </Button>
        {/if}
        {#if permissions.canManageDeployments}
          {#if deployment.status?.phase === "failed" || deployment.status?.phase === "partial"}
            <Button variant="outline" onclick={retry}>
              <RotateCcw class="w-4 h-4" />
              Retry
            </Button>
          {/if}
          <label class="flex items-center gap-2 text-sm cursor-pointer">
            <Switch checked={deployment.enabled} disabled={togglingEnabled} onCheckedChange={setEnabled} />
            Enabled
          </label>
        {/if}
      </div>
    </header>

    <Card.Root>
      <Card.Header class="flex flex-row items-center justify-between">
        <Card.Title>Model</Card.Title>
        {#if view.editModal && permissions.canManageDeployments}
          <Button variant="outline" size="sm" onclick={() => (editing = true)}>
            <Pencil class="w-4 h-4" />
            Edit
          </Button>
        {/if}
      </Card.Header>
      <Card.Content>
        <Panel {deployment} />
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Replicas</Card.Title>
        <Card.Description>
          {view.replicas(deployment)} requested. Each replica runs on its own machine.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if deployment.enabled && deployment.status}
          <ReplicaStatus {deployment} replicas={view.replicas(deployment)} />
        {:else}
          <p class="text-sm text-muted-foreground">
            {deployment.enabled ? "Nothing has been placed yet." : "A disabled deployment runs nowhere."}
          </p>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Details</Card.Title>
      </Card.Header>
      <Card.Content>
        <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          <dt class="text-muted-foreground">Created</dt>
          <dd>{humanDate(deployment.createdAt)}</dd>
          <dt class="text-muted-foreground">Last changed</dt>
          <dd>{humanDate(deployment.updatedAt)}</dd>
          <dt class="text-muted-foreground">Deployment id</dt>
          <dd class="flex items-center gap-2">
            <span class="font-mono">{deployment.id}</span>
            <Button variant="ghost" size="icon" class="h-6 w-6" onclick={() => copyToClipboard(deployment.id)} title="Copy the deployment id">
              <Copy class="w-3 h-3" />
            </Button>
          </dd>
        </dl>
      </Card.Content>
    </Card.Root>

    {#if permissions.canManageDeployments}
      <Card.Root class="border-destructive/40">
        <Card.Header>
          <Card.Title>Danger Zone</Card.Title>
          <Card.Description>Deleting stops serving this deployment and removes it. This cannot be undone.</Card.Description>
        </Card.Header>
        <Card.Content>
          <Button variant="destructive" onclick={() => (confirmingDelete = true)}>
            <Trash2 class="w-4 h-4" />
            Delete deployment
          </Button>
        </Card.Content>
      </Card.Root>
    {/if}
  </div>

  {#if editing && view.editModal}
    {@const EditModal = view.editModal}
    <EditModal
      open={true}
      {deployment}
      nodeCapabilities={data.cluster.nodeCapabilities}
      modelCompatibility={data.cluster.modelCompatibility}
      close={() => (editing = false)}
      onSaved={reload}
    />
  {/if}

  {#if testableType === "chat"}
    <TestChatModal open={testing} deployment={testing ? deployment : null} applications={data.applications ?? []} close={() => (testing = false)} />
  {:else if testableType === "embedding"}
    <TestEmbeddingModal open={testing} deployment={testing ? deployment : null} close={() => (testing = false)} />
  {:else if testableType === "rerank"}
    <TestRerankModal open={testing} deployment={testing ? deployment : null} close={() => (testing = false)} />
  {/if}

  <ConfirmDialog
    open={confirmingDelete}
    title="Delete Deployment"
    description="Are you sure you want to delete {deployment.name}? This action cannot be undone."
    confirmLabel="Delete"
    onConfirm={() => void confirmDelete()}
    onCancel={() => (confirmingDelete = false)}
  />
{/if}
