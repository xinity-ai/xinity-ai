<script lang="ts">
  import { onMount } from "svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { toastState } from "$lib/state/toast.svelte";
  import { permissions } from "$lib/state/permissions.svelte";
  import type { RetentionRun } from "common-db";

  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import { Loader2, ShieldCheck } from "@lucide/svelte";

  let loading = $state(true);
  let isSaving = $state(false);
  let apiCallRetentionDays = $state<number | null>(null);
  let mediaRetentionDays = $state<number | null>(null);
  let policyExists = $state(false);
  let runs = $state<RetentionRun[]>([]);

  async function loadData() {
    loading = true;
    const [policyResult, runsResult] = await Promise.all([
      orpc.compliance.getRetentionPolicy(),
      orpc.compliance.listRetentionRuns(),
    ]);
    const [policyError, policy] = policyResult;
    const [runsError, runRows] = runsResult;
    if (policyError || runsError) {
      toastState.add((policyError ?? runsError)!.message, "error");
    } else {
      policyExists = policy !== null;
      apiCallRetentionDays = policy?.apiCallRetentionDays ?? null;
      mediaRetentionDays = policy?.mediaRetentionDays ?? null;
      runs = runRows.map((r) => ({
        ...r,
        startedAt: new Date(r.startedAt),
        finishedAt: r.finishedAt ? new Date(r.finishedAt) : null,
      })) as RetentionRun[];
    }
    loading = false;
  }

  async function savePolicy() {
    isSaving = true;
    const [error] = await orpc.compliance.setRetentionPolicy({
      apiCallRetentionDays,
      mediaRetentionDays,
    });
    if (error) {
      toastState.add(error.message, "error");
    } else {
      toastState.add("Retention policy saved", "success");
      await loadData();
    }
    isSaving = false;
  }

  function parseDays(value: string): number | null {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }

  onMount(loadData);
</script>

<div class="space-y-6 p-6 max-w-4xl">
  <div class="flex items-center gap-3">
    <ShieldCheck class="w-6 h-6" />
    <div>
      <h1 class="text-xl font-semibold tracking-tight">Compliance</h1>
      <p class="text-sm text-muted-foreground">
        Data retention for inference logs (GDPR Art. 5(1)(e) storage limitation)
      </p>
    </div>
  </div>

  {#if loading}
    <div class="flex items-center gap-2 text-muted-foreground">
      <Loader2 class="w-4 h-4 animate-spin" /> Loading...
    </div>
  {:else}
    <Card.Root>
      <Card.Header>
        <Card.Title>Retention Policy</Card.Title>
        <Card.Description>
          API call logs contain full prompts and completions. Configure how many days to keep
          them; leaving a field empty keeps data forever, which your data protection officer
          must explicitly justify.
          {#if !policyExists}
            <Badge variant="destructive" class="ml-2">Not configured</Badge>
          {/if}
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label for="api-call-retention">API call logs (days)</Label>
            <Input
              id="api-call-retention"
              type="number"
              min="1"
              max="3650"
              placeholder="Keep forever"
              disabled={!permissions.canManageCompliance}
              value={apiCallRetentionDays ?? ""}
              oninput={(e) => (apiCallRetentionDays = parseDays(e.currentTarget.value))}
            />
            <p class="text-xs text-muted-foreground">Prompts, completions, and call metadata</p>
          </div>
          <div class="space-y-1.5">
            <Label for="media-retention">Uploaded images (days)</Label>
            <Input
              id="media-retention"
              type="number"
              min="1"
              max="3650"
              placeholder="Same as API call logs"
              disabled={!permissions.canManageCompliance}
              value={mediaRetentionDays ?? ""}
              oninput={(e) => (mediaRetentionDays = parseDays(e.currentTarget.value))}
            />
            <p class="text-xs text-muted-foreground">Image blobs in the object store</p>
          </div>
        </div>
        {#if permissions.canManageCompliance}
          <Button onclick={savePolicy} disabled={isSaving}>
            {#if isSaving}
              <Loader2 class="w-4 h-4 animate-spin" /> Saving...
            {:else}
              Save Policy
            {/if}
          </Button>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Purge Runs</Card.Title>
        <Card.Description>
          Enforcement evidence: each scheduled purge is recorded and appears in audit reports.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if runs.length === 0}
          <p class="text-sm text-muted-foreground">
            No purge runs yet. Runs execute daily once a retention period is configured.
          </p>
        {:else}
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b text-left text-muted-foreground">
                <th class="py-2 pr-4 font-medium">Started</th>
                <th class="py-2 pr-4 font-medium">API calls deleted</th>
                <th class="py-2 pr-4 font-medium">Images deleted</th>
                <th class="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {#each runs as run (run.id)}
                <tr class="border-b last:border-0">
                  <td class="py-2 pr-4">{run.startedAt.toLocaleString()}</td>
                  <td class="py-2 pr-4">{run.deletedApiCalls}</td>
                  <td class="py-2 pr-4">{run.deletedMediaObjects}</td>
                  <td class="py-2">
                    {#if run.error}
                      <Badge variant="destructive">Error</Badge>
                      <span class="text-xs text-muted-foreground">{run.error}</span>
                    {:else if run.finishedAt}
                      <Badge variant="secondary">Completed</Badge>
                    {:else}
                      <Badge variant="outline">Running</Badge>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}
</div>
