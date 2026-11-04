<script lang="ts">
  import { ArrowRight, TriangleAlert } from "@lucide/svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { toastState } from "$lib/state/toast.svelte";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import type { DeploymentOf } from "$lib/orpc/dtos/model.dto";
  import type { PanelContext } from "./deployment-views";

  let { deployment, context }: { deployment: DeploymentOf<"legacy">; context: PanelContext } = $props();

  let confirming = $state(false);
  let migrating = $state(false);

  const becomes = $derived(
    deployment.legacy.earlySpecifier
      ? `It becomes a rollout of the same two models at ${deployment.legacy.progress}% of traffic, which you then promote or roll back.`
      : `It becomes an ordinary deployment of the same model, with ${deployment.legacy.replicas} ${deployment.legacy.replicas === 1 ? "replica" : "replicas"}.`,
  );

  async function migrate() {
    confirming = false;
    migrating = true;
    const [err] = await orpc.deployments.migrate({ id: deployment.id });
    migrating = false;
    if (err) {
      toastState.add(`Failed to migrate: ${err.message}`, "error");
      return;
    }
    toastState.add(`Migrated "${deployment.name}"`, "success");
    await context.onChanged();
  }
</script>

<div class="flex flex-wrap items-start gap-x-4 gap-y-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-500/10">
  <div class="flex min-w-0 flex-1 basis-80 items-start gap-3">
    <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
    <div class="min-w-0 space-y-1 text-sm">
      <p class="font-semibold">This deployment uses the legacy format</p>
      <p class="text-foreground/80">
        It keeps running, but it can only be enabled, disabled or deleted. Migrate it to change its model, capacity or settings.
        {becomes}
      </p>
    </div>
  </div>
  {#if context.canEdit}
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <Button variant="outline" class="border-amber-400 bg-transparent hover:bg-amber-100 dark:hover:bg-amber-500/20" onclick={() => (confirming = true)} disabled={migrating}>
        <ArrowRight class="w-4 h-4" />
        Migrate
      </Button>
    </div>
  {/if}
</div>

<ConfirmDialog
  open={confirming}
  title="Migrate deployment"
  description="What runs keeps running, and the deployment keeps its id and public name. {becomes} Replicas still waiting for a machine keep waiting. It cannot be turned back into a legacy deployment."
  confirmLabel="Migrate"
  confirmVariant="default"
  onConfirm={() => void migrate()}
  onCancel={() => (confirming = false)}
/>
