<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { ModelWithSpecifier } from "common-env/model-catalog";
  import { browser } from "$app/env";
  import { goto, invalidate } from "$app/navigation";
  import { ArrowLeft, Copy, MessageSquare, Trash2 } from "@lucide/svelte";
  import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
  import { orpc } from "$lib/orpc/orpc-client";
  import { copyToClipboard } from "$lib/copy";
  import { humanDate } from "$lib/util";
  import { formatRelativeTime } from "$lib/compute/format";
  import { toastState } from "$lib/state/toast.svelte";
  import { permissions } from "$lib/state/permissions.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import NoOrganization from "$lib/components/NoOrganization.svelte";
  import type { PageData } from "./$types";
  import { IDLE_REFRESH_MS, refreshEveryMs, viewOf } from "$lib/components/deployments/deployment-types";
  import { detailViewOf, type PanelContext } from "./deployment-views";
  import { sectionsOf, type SectionContext } from "$lib/components/deployments/sections/deployment-sections";
  import PanelCard from "$lib/components/deployments/PanelCard.svelte";
  import SectionCard from "./SectionCard.svelte";
  import ReplicaAlerts from "./ReplicaAlerts.svelte";
  import { isServing, statusDisplayOf } from "$lib/components/deployments/status-display";
  import ReplicaStatus from "./ReplicaStatus.svelte";
  import StatusChip from "$lib/components/deployments/StatusChip.svelte";
  import TestChatModal from "./TestChatModal.svelte";
  import TestEmbeddingModal from "./TestEmbeddingModal.svelte";
  import TestRerankModal from "./TestRerankModal.svelte";

  let { data }: { data: PageData } = $props();

  // Polling and actions replace what the load returned, until the next navigation loads afresh.
  let refreshed = $state<DeploymentOutput | null>(null);
  const deployment = $derived(refreshed && refreshed.id === data.deployment?.id ? refreshed : data.deployment);


  let confirmingDelete = $state(false);
  let confirmingDisable = $state(false);
  let testing = $state(false);
  let togglingEnabled = $state(false);
  const models = new SvelteMap<string, ModelWithSpecifier | null>();

  // A poll that started before a save must not put back what the save replaced.
  let generation = 0;

  async function refresh() {
    if (!deployment) {
      return;
    }
    const started = generation;
    const [err, latest] = await orpc.deployments.get({ id: deployment.id, withStatus: true });
    if (!err && started === generation) {
      refreshed = latest;
    }
  }

  async function reload() {
    generation++;
    await invalidate("resource:cluster");
    refreshed = null;
  }

  const refreshEvery = $derived(deployment ? refreshEveryMs(deployment) ?? IDLE_REFRESH_MS : null);

  $effect(() => {
    if (!browser || refreshEvery === null) {
      return;
    }
    const timer = setInterval(refresh, refreshEvery);
    return () => clearInterval(timer);
  });

  $effect(() => {
    if (!deployment) {
      return;
    }
    const { from, to } = viewOf(deployment).models(deployment);
    for (const specifier of [from, to]) {
      if (specifier && !untrack(() => models.has(specifier))) {
        void orpc.model.get({ specifier }).then(([err, model]) => {
          if (!err) {
            models.set(specifier, model ?? null);
          }
        });
      }
    }
  });

  const nameOf = (specifier: string) => models.get(specifier)?.name ?? specifier;

  const servedType = $derived(deployment ? models.get(viewOf(deployment).models(deployment).to)?.type : undefined);

  const TESTABLE_TYPES = ["chat", "embedding", "rerank"] as const;
  const testableType = $derived(TESTABLE_TYPES.find((testable) => testable === servedType) ?? null);

  // Public names are unique in an organization, so the General section can say so before saving.
  // Narrowed to the id, so a refresh of the same deployment does not ask again.
  const deploymentId = $derived(deployment?.id);
  let takenPublicSpecifiers = $state<string[]>([]);
  $effect(() => {
    const id = deploymentId;
    void orpc.deployments.list({ withStatus: false }).then(([err, deployments]) => {
      if (!err) {
        takenPublicSpecifiers = deployments.filter((other) => other.id !== id).map((other) => other.publicSpecifier);
      }
    });
  });

  const sectionContext = $derived<SectionContext>({
    creating: false,
    enabled: deployment?.enabled ?? false,
    models,
    nodeCapabilities: data.cluster.nodeCapabilities,
    modelCompatibility: data.cluster.modelCompatibility,
    canEdit: permissions.canManageDeployments,
    takenPublicSpecifiers,
    licensedVram: data.cluster.licensedVram,
  });

  const panelContext = $derived<PanelContext>({
    models,
    canEdit: permissions.canManageDeployments,
    nodeCapabilities: data.cluster.nodeCapabilities,
    modelCompatibility: data.cluster.modelCompatibility,
    licensedVram: data.cluster.licensedVram,
    onChanged: reload,
  });

  const CONFIG_COLUMNS: Record<number, string> = { 1: "", 2: "lg:grid-cols-2", 3: "lg:grid-cols-3" };
  const sectionCards = $state<Record<string, { startEditing: () => Promise<void> } | undefined>>({});

  async function editCapacity() {
    await sectionCards.Capacity?.startEditing();
  }

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
  {@const detail = detailViewOf(deployment)}
  {@const ModelPanel = detail.modelPanel}
  {@const editable = sectionsOf(deployment, sectionContext)}
  <div class="p-6 compact:p-3 space-y-5 compact:space-y-3">
    <a href="/modelhub/" class="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft class="w-4 h-4" />
      Model Hub
    </a>

    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="space-y-1 min-w-0">
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="text-2xl font-bold truncate">{deployment.name}</h1>
          <StatusChip display={statusDisplayOf(deployment)} />
          {#if badge}
            <Badge variant="outline" class={badge.class}>{badge.label}</Badge>
          {/if}
        </div>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span class="font-mono text-foreground">{deployment.publicSpecifier}</span>
          <Button variant="ghost" size="icon" class="h-6 w-6 -ml-1" onclick={() => copyToClipboard(deployment.publicSpecifier)} title="Copy the name to call it by" aria-label="Copy the public name">
            <Copy class="w-3 h-3" />
          </Button>
          <span aria-hidden="true">·</span>
          <span title={humanDate(deployment.createdAt)}>created {formatRelativeTime(deployment.createdAt.valueOf(), Date.now())}</span>
          <span aria-hidden="true">·</span>
          <span title={humanDate(deployment.updatedAt)}>changed {formatRelativeTime(deployment.updatedAt.valueOf(), Date.now())}</span>
          <span aria-hidden="true">·</span>
          <button type="button" class="cursor-pointer font-mono hover:text-foreground" onclick={() => copyToClipboard(deployment.id)} title="Copy the deployment id" aria-label="Copy the deployment id, {deployment.id}">
            id {deployment.id.slice(0, 8)}…
          </button>
        </div>
      </div>
      <div class="flex min-h-9 flex-wrap items-center gap-3">
        {#if isServing(deployment) && testableType}
          <Button variant="outline" onclick={() => (testing = true)}>
            <MessageSquare class="w-4 h-4" />
            Test
          </Button>
        {/if}
        {#if permissions.canManageDeployments}
          <label class="flex items-center gap-2 text-sm cursor-pointer">
            <Switch bind:checked={() => deployment.enabled, (enabled) => (enabled ? void setEnabled(true) : (confirmingDisable = true))} disabled={togglingEnabled} />
            {deployment.enabled ? "Enabled" : "Disabled"}
          </label>
        {/if}
      </div>
    </header>

    {#if detail.notice}
      {@const TypeNotice = detail.notice}
      <TypeNotice {deployment} context={panelContext} />
    {/if}

    <PanelCard title="Replicas">
      {#if deployment.enabled}
        <ReplicaAlerts
          {deployment}
          canEdit={permissions.canManageDeployments}
          waitingNote={detail.waitingNote?.(deployment, nameOf) ?? null}
          onRetry={retry}
          onEditReplicas={editable?.sections.some((section) => section.title === "Capacity") ? editCapacity : undefined}
        />
        <ReplicaStatus {deployment} titleOf={(group) => detail.replicaGroupTitle?.(deployment, group, nameOf) ?? nameOf(group.specifier)} />
      {:else}
        <p class="text-sm text-muted-foreground">This deployment is disabled, so it runs nowhere and callers get errors.</p>
      {/if}
    </PanelCard>

    <ModelPanel {deployment} context={panelContext} />

    {#if editable && editable.sections.length > 0}
      <div class="grid grid-cols-[minmax(0,1fr)] gap-5 compact:gap-3 {CONFIG_COLUMNS[editable.sections.length] ?? CONFIG_COLUMNS[3]}">
        {#each editable.sections as section (`${editable.deployment.id}:${section.title}`)}
          <SectionCard bind:this={sectionCards[section.title]} deployment={editable.deployment} title={section.title} component={section.component} fields={section.fields} context={sectionContext} onSaved={reload} />
        {/each}
      </div>
    {/if}

    {#if permissions.canManageDeployments}
      <div class="flex flex-wrap items-center justify-between gap-4 border-t pt-5 compact:pt-3">
        <p class="text-sm text-muted-foreground">Deleting stops serving this deployment and cannot be undone. Disabling it keeps everything for later.</p>
        <Button variant="outline" size="sm" class="text-destructive hover:text-destructive" onclick={() => (confirmingDelete = true)}>
          <Trash2 class="w-4 h-4" />
          Delete deployment
        </Button>
      </div>
    {/if}
  </div>

  {#if testableType === "chat"}
    <TestChatModal open={testing} deployment={testing ? deployment : null} applications={data.applications ?? []} close={() => (testing = false)} />
  {:else if testableType === "embedding"}
    <TestEmbeddingModal open={testing} deployment={testing ? deployment : null} close={() => (testing = false)} />
  {:else if testableType === "rerank"}
    <TestRerankModal open={testing} deployment={testing ? deployment : null} close={() => (testing = false)} />
  {/if}

  <ConfirmDialog
    open={confirmingDisable}
    title="Disable Deployment"
    description="Callers of {deployment.publicSpecifier} get errors until it is enabled again. Its replicas are uninstalled, and the deployment keeps its settings."
    confirmLabel="Disable"
    onConfirm={() => { confirmingDisable = false; void setEnabled(false); }}
    onCancel={() => (confirmingDisable = false)}
  />

  <ConfirmDialog
    open={confirmingDelete}
    title="Delete Deployment"
    description="Are you sure you want to delete {deployment.name}? This action cannot be undone."
    confirmLabel="Delete"
    onConfirm={() => void confirmDelete()}
    onCancel={() => (confirmingDelete = false)}
  />
{/if}
