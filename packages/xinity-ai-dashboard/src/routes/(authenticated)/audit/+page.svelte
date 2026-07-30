<script lang="ts">
  import { onMount } from "svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Switch } from "$lib/components/ui/switch";
  import * as Card from "$lib/components/ui/card";
  import * as Select from "$lib/components/ui/select";
  import { ChevronLeft, ChevronRight, Search, Download, ChevronDown, ChevronUp } from "@lucide/svelte";
  import { toastState } from "$lib/state/toast.svelte";
  import { createUrlSearchParamsStore } from "$lib/urlSearchParamsStore";
  import { humanDate } from "$lib/util";
  import type { PageData } from "./$types";
  import type { AuditEvent } from "common-db";

  let { data }: { data: PageData } = $props();

  const hasFeature = $derived(!!data.license.features.auditLog);

  const searchParams = createUrlSearchParamsStore();

  let events = $state<AuditEvent[]>([]);
  let nextCursor = $state<string | null>(null);
  let cursorStack = $state<string[]>([]);
  let loading = $state(false);
  let expandedRow = $state<string | null>(null);
  let instanceView = $state(false);

  let actorInputValue = $state($searchParams.actor ?? "");

  const LIMIT = 50;

  const AUDIT_ACTIONS = [
    "account.change_password",
    "account.create_dashboard_api_key",
    "account.delete_dashboard_api_key",
    "account.delete_passkey",
    "account.disable_2fa",
    "account.enable_2fa",
    "account.request_password_reset",
    "account.sign_in",
    "account.sign_in_sso",
    "account.sign_out",
    "account.sign_up",
    "account.verify_email",
    "aiApplication.create",
    "aiApplication.delete",
    "aiApplication.update",
    "apiCall.delete",
    "apiCall.reassign_application",
    "apiCall.update_metadata",
    "apiKey.create",
    "apiKey.delete",
    "apiKey.toggle_collect_data",
    "apiKey.toggle_enabled",
    "apiKey.update",
    "compute.remove_node",
    "instanceAdmin.add_user_to_org",
    "instanceAdmin.ban_user",
    "instanceAdmin.create_user",
    "instanceAdmin.remove_user_from_org",
    "instanceAdmin.reset_user_password",
    "instanceAdmin.set_email_verified",
    "instanceAdmin.set_sso_self_manage",
    "instanceAdmin.unban_user",
    "instanceAdmin.update_user_role",
    "invitation.cancel",
    "invitation.create",
    "member.remove",
    "member.update_role",
    "modelDeployment.create",
    "modelDeployment.delete",
    "modelDeployment.retry",
    "modelDeployment.toggle_enabled",
    "modelDeployment.update",
    "onboarding.cli",
    "onboarding.setup",
    "organization.create",
    "organization.delete",
    "organization.update",
    "sso.delete_provider",
    "sso.register_oidc",
    "sso.register_saml",
    "user.update_settings",
  ] as const;

  const RESOURCE_GROUPS: Record<string, string[]> = {};
  for (const a of AUDIT_ACTIONS) {
    const resource = a.split(".")[0]!;
    if (!RESOURCE_GROUPS[resource]) {
      RESOURCE_GROUPS[resource] = [];
    }
    RESOURCE_GROUPS[resource].push(a);
  }

  async function fetchEvents(cursor?: string) {
    if (!hasFeature) {
      return;
    }
    loading = true;
    const result = await orpc.audit.list({
      limit: LIMIT,
      cursor: cursor || undefined,
      action: $searchParams.action || undefined,
      result: ($searchParams.result as "success" | "failure") || undefined,
      actorId: $searchParams.actor || undefined,
      from: $searchParams.from ? new Date($searchParams.from) : undefined,
      to: $searchParams.to ? new Date($searchParams.to) : undefined,
      includeInstanceEvents: instanceView,
    });
    loading = false;
    if (result.error) {
      toastState.add(result.error.message || "Failed to load audit events", "error");
      return;
    }
    events = result.data.events;
    nextCursor = result.data.nextCursor;
  }

  function applyFilters() {
    cursorStack = [];
    void fetchEvents();
  }

  function clearFilters() {
    $searchParams.action = "";
    $searchParams.result = "";
    $searchParams.actor = "";
    $searchParams.from = "";
    $searchParams.to = "";
    actorInputValue = "";
    cursorStack = [];
    void fetchEvents();
  }

  function goNext() {
    if (!nextCursor) {
      return;
    }
    const currentFirst = events[0]?.createdAt.toISOString();
    if (currentFirst) {
      cursorStack = [...cursorStack, currentFirst];
    }
    void fetchEvents(nextCursor);
  }

  function goPrev() {
    if (cursorStack.length === 0) {
      return;
    }
    const prev = cursorStack[cursorStack.length - 2];
    cursorStack = cursorStack.slice(0, -1);
    void fetchEvents(prev);
  }

  function toggleRow(id: string) {
    expandedRow = expandedRow === id ? null : id;
  }

  let actorSearchTimeout: ReturnType<typeof setTimeout> | undefined;

  function onActorInput(e: Event) {
    actorInputValue = (e.target as HTMLInputElement).value;
    clearTimeout(actorSearchTimeout);
    actorSearchTimeout = setTimeout(() => {
      $searchParams.actor = actorInputValue || "";
      applyFilters();
    }, 400);
  }

  function formatAction(action: string): string {
    const [resource, verb] = action.split(".");
    if (!verb) {
      return action;
    }
    return `${resource}: ${verb.replace(/_/g, " ")}`;
  }

  function actorDisplay(event: AuditEvent): string {
    if (event.actorLabel) {
      return event.actorLabel;
    }
    if (event.actorId) {
      return event.actorId.slice(0, 8) + "...";
    }
    return event.actorType;
  }

  async function handleExport(format: "ndjson" | "csv") {
    const from = $searchParams.from ? new Date($searchParams.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = $searchParams.to ? new Date($searchParams.to) : undefined;

    const result = await orpc.audit.export({ from, to, includeInstanceEvents: instanceView });
    if (result.error) {
      toastState.add(result.error.message || "Export failed", "error");
      return;
    }

    const { events: rows, truncated } = result.data;

    if (truncated) {
      toastState.add("Export was capped at 10,000 rows. Narrow the date range for a complete export.", "warning");
    }

    let content: string;
    let mimeType: string;
    let extension: string;

    if (format === "ndjson") {
      content = rows.map((r: AuditEvent) => JSON.stringify(r)).join("\n");
      mimeType = "application/x-ndjson";
      extension = "jsonl";
    } else {
      const headers = ["id", "createdAt", "actorType", "actorId", "actorLabel", "action", "resource", "resourceId", "result", "ipAddress", "userAgent", "context"];
      const csvRows = rows.map((r: AuditEvent) =>
        headers.map((h) => {
          const val = r[h as keyof AuditEvent];
          if (val === null || val === undefined) {
            return "";
          }
          if (val instanceof Date) {
            return val.toISOString();
          }
          if (typeof val === "object") {
            return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
          }
          const s = String(val);
          if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        }).join(","),
      );
      content = [headers.join(","), ...csvRows].join("\n");
      mimeType = "text/csv";
      extension = "csv";
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-export-${new Date().toISOString().slice(0, 10)}.${extension}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  let exportMenuOpen = $state(false);

  const hasActiveFilters = $derived(
    !!($searchParams.action || $searchParams.result || $searchParams.actor || $searchParams.from || $searchParams.to),
  );

  onMount(() => {
    void fetchEvents();
    return () => clearTimeout(actorSearchTimeout);
  });
</script>

<svelte:head>
  <title>Audit Log</title>
</svelte:head>

<div class="container max-w-6xl px-6 py-8 compact:py-4 mx-auto">
  <div class="mb-6 compact:mb-3 flex items-start justify-between">
    <div>
      <h1 class="text-2xl font-bold text-foreground">Audit Log</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        {#if instanceView}
          All events across the instance, including actions outside any organization.
        {:else}
          Security-relevant events for your organization.
        {/if}
      </p>
    </div>
    {#if data.isInstanceAdmin}
      <label class="flex items-center gap-2 cursor-pointer">
        <span class="text-sm text-muted-foreground">Instance view</span>
        <Switch
          checked={instanceView}
          onCheckedChange={(v) => { instanceView = v; applyFilters(); }}
        />
      </label>
    {/if}
  </div>

  {#if !hasFeature}
    <Card.Root>
      <Card.Content class="py-12 text-center">
        <h2 class="text-lg font-semibold mb-2">Audit Log requires an Enterprise license</h2>
        <p class="text-sm text-muted-foreground mb-4">
          The audit log provides a tamper-evident record of all security-relevant actions
          in your organization, with filtering, export, and SIEM integration.
        </p>
        <Button href="https://xinity.ai/xinity-pricing" target="_blank" rel="noopener noreferrer">
          View Plans
        </Button>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root>
      <Card.Header>
        <div class="flex items-center justify-between">
          <div>
            <Card.Title>Events</Card.Title>
            <Card.Description>Browse and filter audit events</Card.Description>
          </div>
          <div class="relative">
            <Button variant="outline" onclick={() => { exportMenuOpen = !exportMenuOpen; }}>
              <Download class="w-4 h-4 mr-2" />
              Export
            </Button>
            {#if exportMenuOpen}
              <div class="absolute right-0 top-full mt-1 w-40 rounded-md border bg-popover p-1 shadow-md z-50">
                <button
                  class="w-full rounded-sm px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
                  onclick={() => { exportMenuOpen = false; handleExport("ndjson"); }}
                >
                  NDJSON (.jsonl)
                </button>
                <button
                  class="w-full rounded-sm px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground"
                  onclick={() => { exportMenuOpen = false; handleExport("csv"); }}
                >
                  CSV (.csv)
                </button>
              </div>
            {/if}
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mt-4">
          <Select.Root
            type="single"
            value={$searchParams.action}
            onValueChange={(v) => { $searchParams.action = v ?? ""; applyFilters(); }}
          >
            <Select.Trigger class="w-full">
              {$searchParams.action ? formatAction($searchParams.action) : "All actions"}
            </Select.Trigger>
            <Select.Content class="max-h-64">
              <Select.Item value="" label="All actions" />
              {#each Object.entries(RESOURCE_GROUPS) as [resource, actions]}
                <Select.Group>
                  <Select.GroupHeading>{resource}</Select.GroupHeading>
                  {#each actions as action}
                    <Select.Item value={action} label={formatAction(action)} />
                  {/each}
                </Select.Group>
              {/each}
            </Select.Content>
          </Select.Root>

          <Select.Root
            type="single"
            value={$searchParams.result}
            onValueChange={(v) => { $searchParams.result = v ?? ""; applyFilters(); }}
          >
            <Select.Trigger class="w-full">
              {$searchParams.result ? ($searchParams.result === "success" ? "Success" : "Failure") : "All results"}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="" label="All results" />
              <Select.Item value="success" label="Success" />
              <Select.Item value="failure" label="Failure" />
            </Select.Content>
          </Select.Root>

          <div class="relative">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Actor ID..."
              value={actorInputValue}
              oninput={onActorInput}
              class="pl-9"
            />
          </div>

          <Input
            type="date"
            value={$searchParams.from ?? ""}
            oninput={(e) => { $searchParams.from = (e.target as HTMLInputElement).value; applyFilters(); }}
            placeholder="From"
          />

          <div class="flex gap-2">
            <Input
              type="date"
              value={$searchParams.to ?? ""}
              oninput={(e) => { $searchParams.to = (e.target as HTMLInputElement).value; applyFilters(); }}
              placeholder="To"
              class="flex-1"
            />
            {#if hasActiveFilters}
              <Button variant="ghost" size="sm" onclick={clearFilters} class="shrink-0">
                Clear
              </Button>
            {/if}
          </div>
        </div>
      </Card.Header>

      <Card.Content>
        {#if loading && events.length === 0}
          <p class="text-center text-muted-foreground py-8">Loading...</p>
        {:else if events.length === 0}
          <p class="text-center text-muted-foreground py-8">No audit events found.</p>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b text-left">
                  <th class="py-2 pr-4 font-medium text-muted-foreground w-6"></th>
                  <th class="py-2 pr-4 font-medium text-muted-foreground">Timestamp</th>
                  <th class="py-2 pr-4 font-medium text-muted-foreground">Actor</th>
                  <th class="py-2 pr-4 font-medium text-muted-foreground">Action</th>
                  <th class="py-2 pr-4 font-medium text-muted-foreground">Resource</th>
                  <th class="py-2 pr-4 font-medium text-muted-foreground">Result</th>
                  <th class="py-2 font-medium text-muted-foreground">IP</th>
                </tr>
              </thead>
              <tbody>
                {#each events as event (event.id)}
                  <tr class="border-b last:border-0 hover:bg-muted/50">
                    <td class="py-3 pr-2">
                      {#if event.context && Object.keys(event.context).length > 0}
                        <button
                          class="text-muted-foreground hover:text-foreground"
                          onclick={() => toggleRow(event.id)}
                          aria-label={expandedRow === event.id ? "Collapse details" : "Expand details"}
                        >
                          {#if expandedRow === event.id}
                            <ChevronUp class="w-4 h-4" />
                          {:else}
                            <ChevronDown class="w-4 h-4" />
                          {/if}
                        </button>
                      {/if}
                    </td>
                    <td class="py-3 pr-4 text-muted-foreground text-xs whitespace-nowrap">
                      {humanDate(event.createdAt)}
                    </td>
                    <td class="py-3 pr-4">
                      <div class="flex items-center gap-1.5">
                        <Badge variant="outline" class="text-[10px] shrink-0">
                          {event.actorType.replace("_", " ")}
                        </Badge>
                        <span class="truncate max-w-[160px]" title={event.actorLabel ?? event.actorId ?? ""}>
                          {actorDisplay(event)}
                        </span>
                      </div>
                    </td>
                    <td class="py-3 pr-4 font-mono text-xs">
                      {event.action}
                    </td>
                    <td class="py-3 pr-4">
                      <span>{event.resource}</span>
                      {#if event.resourceId}
                        <span class="text-muted-foreground text-xs ml-1" title={event.resourceId}>
                          ({event.resourceId.slice(0, 8)}...)
                        </span>
                      {/if}
                    </td>
                    <td class="py-3 pr-4">
                      <Badge variant={event.result === "success" ? "outline" : "destructive"}>
                        {event.result}
                      </Badge>
                    </td>
                    <td class="py-3 text-muted-foreground text-xs">
                      {event.ipAddress ?? ""}
                    </td>
                  </tr>
                  {#if expandedRow === event.id && event.context}
                    <tr class="border-b last:border-0">
                      <td colspan="7" class="px-4 py-3 bg-muted/30">
                        <pre class="text-xs font-mono whitespace-pre-wrap break-all">{JSON.stringify(event.context, null, 2)}</pre>
                      </td>
                    </tr>
                  {/if}
                {/each}
              </tbody>
            </table>
          </div>

          <div class="flex items-center justify-between mt-4 pt-4 border-t">
            <span class="text-sm text-muted-foreground">
              Page {cursorStack.length + 1}
            </span>
            <div class="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={cursorStack.length === 0}
                onclick={goPrev}
              >
                <ChevronLeft class="w-4 h-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!nextCursor}
                onclick={goNext}
              >
                Next
                <ChevronRight class="w-4 h-4" />
              </Button>
            </div>
          </div>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}
</div>
