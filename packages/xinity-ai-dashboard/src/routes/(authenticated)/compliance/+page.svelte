<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { orpc } from "$lib/orpc/orpc-client";
  import { toastState } from "$lib/state/toast.svelte";
  import { permissions } from "$lib/state/permissions.svelte";
  import type { AuditLog, RetentionRun } from "common-db";

  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import { Loader2, ShieldCheck } from "@lucide/svelte";
  import PostureCheckRow, { type PostureCheckView, type ComplianceFramework } from "./PostureCheckRow.svelte";
  import FrameworkProgress from "./FrameworkProgress.svelte";

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

  // Posture report (licensed feature)
  const complianceReportsLicensed = $derived(Boolean(page.data.license?.features?.complianceReports));
  type PostureSummary = { pass: number; warn: number; fail: number; total: number };
  let postureChecks = $state<PostureCheckView[]>([]);
  let postureSummary = $state<PostureSummary | null>(null);
  let postureLoading = $state(false);

  const automatedChecks = $derived(postureChecks.filter((c) => c.kind === "automated"));
  const organizationalChecks = $derived(postureChecks.filter((c) => c.kind === "organizational"));

  const FRAMEWORK_ORDER: ComplianceFramework[] = ["GDPR", "EU AI Act", "NIS2"];
  const frameworkStats = $derived(
    FRAMEWORK_ORDER.map((framework) => {
      const checks = postureChecks.filter((c) => c.frameworks.includes(framework));
      return { framework, pass: checks.filter((c) => c.status === "pass").length, total: checks.length };
    }).filter((s) => s.total > 0),
  );

  async function loadPosture() {
    postureLoading = true;
    const [error, report] = await orpc.compliance.getPosture();
    if (error) {
      toastState.add(error.message, "error");
    } else {
      postureChecks = report.checks as PostureCheckView[];
      postureSummary = report.summary;
    }
    postureLoading = false;
  }

  // Audit pack generation
  function isoDay(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
  let packFrom = $state(isoDay(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)));
  let packTo = $state(isoDay(new Date()));
  const packUrl = $derived(`/compliance/audit-pack?from=${packFrom}&to=${packTo}`);

  // Audit log (licensed feature)
  const auditLogLicensed = $derived(Boolean(page.data.license?.features?.auditLog));
  type AuditCursor = { createdAt: Date; id: string };
  let auditEntries = $state<AuditLog[]>([]);
  let auditCursor = $state<AuditCursor | null>(null);
  let auditActionFilter = $state("");
  let auditLoading = $state(false);

  async function loadAuditLog(append: boolean) {
    auditLoading = true;
    const [error, result] = await orpc.compliance.listAuditLog({
      action: auditActionFilter || undefined,
      cursor: append && auditCursor ? auditCursor : undefined,
    });
    if (error) {
      toastState.add(error.message, "error");
    } else {
      const entries = result.entries.map((e) => ({ ...e, createdAt: new Date(e.createdAt) })) as AuditLog[];
      auditEntries = append ? [...auditEntries, ...entries] : entries;
      auditCursor = result.nextCursor
        ? { createdAt: new Date(result.nextCursor.createdAt), id: result.nextCursor.id }
        : null;
    }
    auditLoading = false;
  }

  function detailsSummary(details: Record<string, unknown> | null): string {
    if (!details) return "";
    return Object.entries(details)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(", ");
  }

  onMount(() => {
    void loadData();
    if (complianceReportsLicensed) void loadPosture();
    if (auditLogLicensed && permissions.canViewAuditLog) void loadAuditLog(false);
  });
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
    {#if !complianceReportsLicensed}
      <Card.Root>
        <Card.Header>
          <Card.Title>Compliance Posture</Card.Title>
        </Card.Header>
        <Card.Content>
          <p class="text-sm text-muted-foreground">
            The posture dashboard runs automated checks against your platform state and tracks
            the organizational documents auditors ask for (DPIA, usage policy, training records).
            It requires a license with the compliance-reports feature.
            <a class="underline" href="https://xinity.ai/xinity-pricing" target="_blank" rel="noreferrer">
              Upgrade to unlock it.
            </a>
          </p>
        </Card.Content>
      </Card.Root>
    {:else}
      <Card.Root>
        <Card.Header>
          <div class="flex items-center justify-between">
            <div>
              <Card.Title>Compliance Posture</Card.Title>
              <Card.Description>
                {#if postureSummary}
                  {postureSummary.pass} of {postureSummary.total} checks evidence-complete
                  {#if postureSummary.fail > 0}
                    · <span class="text-red-600 font-medium">{postureSummary.fail} gaps</span>
                  {/if}
                  {#if postureSummary.warn > 0}
                    · <span class="text-amber-600 font-medium">{postureSummary.warn} need attention</span>
                  {/if}
                {:else}
                  Evidence status across automated platform checks and organizational documents
                {/if}
              </Card.Description>
            </div>
            <Button variant="secondary" size="sm" disabled={postureLoading} onclick={loadPosture}>
              {#if postureLoading}
                <Loader2 class="w-4 h-4 animate-spin" />
              {:else}
                Refresh
              {/if}
            </Button>
          </div>
        </Card.Header>
        <Card.Content class="space-y-6">
          {#if frameworkStats.length > 0}
            <div class="flex flex-wrap justify-center gap-4 sm:gap-6">
              {#each frameworkStats as fw (fw.framework)}
                <FrameworkProgress framework={fw.framework} pass={fw.pass} total={fw.total} />
              {/each}
            </div>
            <p class="text-center text-xs text-muted-foreground -mt-2">
              Complete every evidence item for a framework to earn its audit-ready badge.
            </p>
          {/if}
          <div>
            <h3 class="text-sm font-semibold mb-1">Automated checks</h3>
            <p class="text-xs text-muted-foreground mb-2">Computed live from platform state.</p>
            {#each automatedChecks as check (check.id)}
              <PostureCheckRow {check} canManage={permissions.canManageCompliance} onChanged={loadPosture} />
            {/each}
          </div>
          <div>
            <h3 class="text-sm font-semibold mb-1">Organizational evidence</h3>
            <p class="text-xs text-muted-foreground mb-2">
              Documents only your organization can produce. The platform tracks them and includes
              them in the audit pack; it never authors them. A green status means evidence is
              complete, not that you are compliant — that conclusion stays with your DPO.
            </p>
            {#each organizationalChecks as check (check.id)}
              <PostureCheckRow {check} canManage={permissions.canManageCompliance} onChanged={loadPosture} />
            {/each}
          </div>
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Card.Title>Audit Evidence Pack</Card.Title>
          <Card.Description>
            One self-contained ZIP for your auditor: a printable report (AI system register,
            ROPA annex, TOMs, retention enforcement, access records, deployer classification),
            machine-readable evidence, and your uploaded documents. Missing documents are
            listed as explicit gaps. The pack is evidence, not a certification.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div class="flex flex-wrap items-end gap-3">
            <div class="space-y-1.5">
              <Label for="pack-from">From</Label>
              <Input id="pack-from" type="date" class="w-40" bind:value={packFrom} />
            </div>
            <div class="space-y-1.5">
              <Label for="pack-to">To</Label>
              <Input id="pack-to" type="date" class="w-40" bind:value={packTo} />
            </div>
            <Button href={packUrl} download>Generate Audit Pack</Button>
          </div>
        </Card.Content>
      </Card.Root>
    {/if}

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

    {#if permissions.canViewAuditLog}
      <Card.Root>
        <Card.Header>
          <Card.Title>Audit Log</Card.Title>
          <Card.Description>
            Administrative actions: who did what, when. Events are always recorded;
            viewing requires a license with the audit-log feature.
          </Card.Description>
        </Card.Header>
        <Card.Content class="space-y-4">
          {#if !auditLogLicensed}
            <p class="text-sm text-muted-foreground">
              Your license does not include the audit log.
              <a class="underline" href="https://xinity.ai/xinity-pricing" target="_blank" rel="noreferrer">
                Upgrade to unlock it.
              </a>
              Events are still being recorded, so the trail is complete once unlocked.
            </p>
          {:else}
            <div class="flex items-end gap-3">
              <div class="space-y-1.5">
                <Label for="audit-action-filter">Filter by action</Label>
                <Input
                  id="audit-action-filter"
                  placeholder='e.g. "deployment." or "member."'
                  class="w-64"
                  bind:value={auditActionFilter}
                  onkeydown={(e) => e.key === "Enter" && loadAuditLog(false)}
                />
              </div>
              <Button variant="secondary" disabled={auditLoading} onclick={() => loadAuditLog(false)}>
                Apply
              </Button>
            </div>

            {#if auditEntries.length === 0 && !auditLoading}
              <p class="text-sm text-muted-foreground">No audit events recorded yet.</p>
            {:else}
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b text-left text-muted-foreground">
                    <th class="py-2 pr-4 font-medium">Time</th>
                    <th class="py-2 pr-4 font-medium">Actor</th>
                    <th class="py-2 pr-4 font-medium">Action</th>
                    <th class="py-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {#each auditEntries as entry (entry.id)}
                    <tr class="border-b last:border-0 align-top">
                      <td class="py-2 pr-4 whitespace-nowrap">{entry.createdAt.toLocaleString()}</td>
                      <td class="py-2 pr-4">{entry.actorEmail ?? "system"}</td>
                      <td class="py-2 pr-4"><Badge variant="outline">{entry.action}</Badge></td>
                      <td class="py-2 text-muted-foreground break-all">{detailsSummary(entry.details)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              {#if auditCursor}
                <Button variant="secondary" disabled={auditLoading} onclick={() => loadAuditLog(true)}>
                  {#if auditLoading}
                    <Loader2 class="w-4 h-4 animate-spin" /> Loading...
                  {:else}
                    Load more
                  {/if}
                </Button>
              {/if}
            {/if}
          {/if}
        </Card.Content>
      </Card.Root>
    {/if}
  {/if}
</div>
