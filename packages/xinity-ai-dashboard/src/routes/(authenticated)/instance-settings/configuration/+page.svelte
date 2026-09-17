<script lang="ts">
  import { onMount } from "svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Card from "$lib/components/ui/card";
  import * as Select from "$lib/components/ui/select";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { Badge } from "$lib/components/ui/badge";
  import { Switch } from "$lib/components/ui/switch";
  import { Search, RotateCcw, TriangleAlert } from "@lucide/svelte";
  import { toastState } from "$lib/state/toast.svelte";
  import type { DynamicGroupSummary, DynamicSettingSummary } from "./dynamic-settings";

  type Override = { value?: string; digest?: string; updatedBy: string | null; updatedAt: string };

  let settings = $state<DynamicSettingSummary[]>([]);
  let groups = $state<DynamicGroupSummary[]>([]);
  let groupDrafts = $state<Record<string, Record<string, string>>>({});
  let notDelegatedHere = $state<Set<string>>(new Set());
  let overrides = $state<Record<string, Override>>({});
  let drafts = $state<Record<string, string>>({});
  let busy = $state<string | null>(null);
  let query = $state("");
  let onlyManaged = $state(false);

  function isGroupManaged(group: DynamicGroupSummary): boolean {
    return group.members.every((member) => overrides[member.key]);
  }

  const managedCount = $derived(
    settings.filter((setting) => overrides[setting.key]).length + groups.filter(isGroupManaged).length,
  );

  const needle = $derived(query.trim().toLowerCase());

  const visible = $derived.by(() => settings.filter((setting) => {
    if (onlyManaged && !overrides[setting.key]) {
      return false;
    }
    return !needle || `${setting.key} ${setting.description}`.toLowerCase().includes(needle);
  }));

  const visibleGroups = $derived.by(() => groups.filter((group) => {
    if (onlyManaged && !isGroupManaged(group)) {
      return false;
    }
    const haystack = [group.title, group.description, ...group.members.map((member) => member.key)];
    return !needle || haystack.join(" ").toLowerCase().includes(needle);
  }));

  /** Sections and groups in one ordered stream, so a group is not stranded below the filter. */
  const blocks = $derived.by(() => {
    const bySection = new Map<string, DynamicSettingSummary[]>();
    for (const setting of visible) {
      const name = setting.group ?? "General";
      bySection.set(name, [...(bySection.get(name) ?? []), setting]);
    }

    return [
      ...[...bySection.entries()].map(([name, items]) => ({ kind: "section" as const, name, items })),
      ...visibleGroups.map((group) => ({ kind: "group" as const, name: group.title, group })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  });

  async function refresh() {
    const { data } = await orpc.dynamicConfig.list({});
    if (!data) {
      return;
    }
    settings = data.settings;
    groups = data.groups;
    notDelegatedHere = new Set(data.notDelegatedHere);
    overrides = Object.fromEntries(data.overrides.map((override) => [override.key, {
      value: override.value,
      digest: override.digest,
      updatedBy: override.updatedBy,
      updatedAt: String(override.updatedAt),
    }]));
    drafts = {};
    // A secret is never read back, so its box always starts blank and has to be retyped to save.
    groupDrafts = Object.fromEntries(groups.map((group) => [
      group.id,
      Object.fromEntries(group.members.map((member) => [
        member.key,
        member.isSecret ? "" : overrides[member.key]?.value ?? "",
      ])),
    ]));
  }

  function setGroupDraft(group: DynamicGroupSummary, key: string, value: string) {
    groupDrafts = { ...groupDrafts, [group.id]: { ...groupDrafts[group.id], [key]: value } };
  }

  async function saveGroup(group: DynamicGroupSummary) {
    busy = group.id;
    const { error } = await orpc.dynamicConfig.setGroup({
      id: group.id,
      values: groupDrafts[group.id] ?? {},
    });
    busy = null;
    if (error) {
      toastState.add(error.message, "error");
      return;
    }
    toastState.add(`${group.title} is now managed from here`, "success");
    await refresh();
  }

  async function clearGroup(group: DynamicGroupSummary) {
    busy = group.id;
    const { error } = await orpc.dynamicConfig.clearGroup({ id: group.id });
    busy = null;
    if (error) {
      toastState.add(error.message, "error");
      return;
    }
    toastState.add(`${group.title} returned to each component's own value`, "success");
    await refresh();
  }

  /** What the field shows when untouched: the managed value, or the value the schema declares. */
  function settledValue(setting: DynamicSettingSummary): string {
    if (setting.isSecret) {
      return "";
    }
    return overrides[setting.key]?.value ?? setting.defaultValue ?? "";
  }

  /** `configBool` accepts several spellings, so a value set outside the dashboard may not be "true". */
  function isOn(value: string): boolean {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }

  function draftOf(setting: DynamicSettingSummary): string {
    return drafts[setting.key] ?? settledValue(setting);
  }

  function edited(setting: DynamicSettingSummary): boolean {
    return drafts[setting.key] !== undefined && drafts[setting.key] !== settledValue(setting);
  }

  function discard(key: string) {
    const { [key]: _dropped, ...rest } = drafts;
    drafts = rest;
  }

  async function save(setting: DynamicSettingSummary) {
    busy = setting.key;
    const { error } = await orpc.dynamicConfig.set({ key: setting.key, value: draftOf(setting) });
    busy = null;
    if (error) {
      toastState.add(error.message, "error");
      return;
    }
    toastState.add(`${setting.key} is now managed from here`, "success");
    await refresh();
  }

  async function clear(setting: DynamicSettingSummary) {
    busy = setting.key;
    const { error } = await orpc.dynamicConfig.clear({ key: setting.key });
    busy = null;
    if (error) {
      toastState.add(error.message, "error");
      return;
    }
    toastState.add(`${setting.key} returned to each component's own value`, "success");
    await refresh();
  }

  onMount(refresh);
</script>

<svelte:head>
  <title>Configuration</title>
</svelte:head>

<div class="space-y-4">
  <Card.Root>
    <Card.Header>
      <Card.Title>Configuration</Card.Title>
      <Card.Description>
        Settings a component can take from here instead of its own environment file, and only when it
        was started with <code class="font-mono">@dynamic</code> for that setting. Clearing one returns
        every component to the value it was configured with, which may differ between hosts.
      </Card.Description>
    </Card.Header>
  </Card.Root>

  <div class="flex flex-wrap items-center gap-2">
    <div class="relative min-w-56 flex-1">
      <Search class="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input class="pl-8" placeholder="Filter settings" bind:value={query} />
    </div>
    <div class="flex items-center gap-1">
      <Button variant={onlyManaged ? "outline" : "secondary"} size="sm" onclick={() => (onlyManaged = false)}>
        All {settings.length + groups.length}
      </Button>
      <Button variant={onlyManaged ? "secondary" : "outline"} size="sm" onclick={() => (onlyManaged = true)}>
        Managed here {managedCount}
      </Button>
    </div>
  </div>

  {#each blocks as block (`${block.kind}:${block.name}`)}
    {#if block.kind === "section"}
    <Card.Root>
      <Card.Header class="pb-2">
        <Card.Title class="text-base">{block.name}</Card.Title>
      </Card.Header>
      <Card.Content class="p-0">
        {#each block.items as setting (setting.key)}
          {@const override = overrides[setting.key]}
          {@const dirty = edited(setting)}
          <div
            class="flex flex-col gap-3 border-t border-l-2 px-6 py-4 lg:flex-row lg:items-start lg:gap-6
                   {override ? 'border-l-primary' : 'border-l-transparent'}"
          >
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-sm font-medium">{setting.key}</span>
                {#each setting.components as component (component)}
                  <Badge variant="outline" class="font-normal">{component}</Badge>
                {/each}
                {#if setting.isSecret}
                  <Badge variant="secondary" class="font-normal">secret</Badge>
                {/if}
              </div>
              <p class="text-sm text-muted-foreground">{setting.description}</p>
              {#if notDelegatedHere.has(setting.key)}
                <p class="text-xs text-amber-600 dark:text-amber-400">
                  This dashboard was not started with <code class="font-mono">@dynamic</code> for this setting, so a
                  value set here is stored but ignored until it is.
                </p>
              {/if}
              {#if override}
                <p class="text-xs text-muted-foreground">
                  Set by {override.updatedBy ?? "an unknown user"} on
                  {new Date(override.updatedAt).toLocaleString()}
                  {#if override.digest}
                    <span class="font-mono" title="Fingerprint of the stored value, so you can tell it apart from another without revealing either">
                      &middot; {override.digest}
                    </span>
                  {/if}
                </p>
              {:else}
                <Tooltip.Provider>
                  <Tooltip.Root>
                    <Tooltip.Trigger>
                      <span class="text-xs text-muted-foreground underline decoration-dotted">
                        Declared default
                      </span>
                    </Tooltip.Trigger>
                    <Tooltip.Content>
                      A component started with a fallback of its own runs that instead, and this page
                      cannot see it.
                    </Tooltip.Content>
                  </Tooltip.Root>
                </Tooltip.Provider>
              {/if}
            </div>

            <div class="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
              {#if setting.kind === "boolean"}
                <label class="flex w-56 cursor-pointer items-center gap-2">
                  <Switch
                    checked={isOn(draftOf(setting))}
                    onCheckedChange={(on) => (drafts[setting.key] = String(on))}
                  />
                  <span class="text-sm text-muted-foreground">
                    {isOn(draftOf(setting)) ? "Enabled" : "Disabled"}
                  </span>
                </label>
              {:else if setting.enumValues}
                <Select.Root
                  type="single"
                  value={draftOf(setting)}
                  onValueChange={(value) => (drafts[setting.key] = value)}
                >
                  <Select.Trigger class="w-56">{draftOf(setting) || "Select a value"}</Select.Trigger>
                  <Select.Content>
                    {#each setting.enumValues as option (option)}
                      <Select.Item value={option}>{option}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
              {:else}
                <Input
                  class="w-56 font-mono"
                  type={setting.isSecret ? "password" : setting.kind === "string" ? "text" : "number"}
                  placeholder={setting.isSecret
                    ? (override ? "Stored, enter a value to replace it" : "Not set")
                    : setting.defaultValue ?? ""}
                  value={draftOf(setting)}
                  oninput={(event) => (drafts[setting.key] = event.currentTarget.value)}
                />
              {/if}

              {#if dirty}
                <Button size="sm" disabled={busy === setting.key} onclick={() => save(setting)}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === setting.key}
                  onclick={() => discard(setting.key)}
                >
                  Cancel
                </Button>
              {:else if override}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === setting.key}
                  onclick={() => clear(setting)}
                >
                  <RotateCcw class="size-4" />
                  Clear
                </Button>
              {/if}
            </div>
          </div>
        {/each}
      </Card.Content>
    </Card.Root>
    {:else}
    {@const group = block.group}
    {@const managed = isGroupManaged(group)}
    {@const busyHere = busy === group.id}
    <Card.Root>
      <Card.Header class="pb-2">
        <Card.Title class="text-base">{group.title}</Card.Title>
        <Card.Description>
          {group.description}
          These are saved together, because neither is valid without the other.
        </Card.Description>
        {#if group.warning}
          <p class="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0" />
            <span>{group.warning}</span>
          </p>
        {/if}
      </Card.Header>
      <Card.Content
        class="space-y-3 border-l-2 {managed ? 'border-l-primary' : 'border-l-transparent'}"
      >
        {#each group.members as member (member.key)}
          <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
            <div class="min-w-0 sm:w-72">
              <span class="font-mono text-sm font-medium">{member.key}</span>
              {#if member.isSecret}
                <Badge variant="secondary" class="ml-2 font-normal">secret</Badge>
              {/if}
              <p class="text-xs text-muted-foreground">{member.description}</p>
            </div>
            {#if member.enumValues}
              <Select.Root
                type="single"
                value={groupDrafts[group.id]?.[member.key] ?? ""}
                onValueChange={(value) => setGroupDraft(group, member.key, value)}
              >
                <Select.Trigger class="w-56">
                  {groupDrafts[group.id]?.[member.key] || "Select a value"}
                </Select.Trigger>
                <Select.Content>
                  {#each member.enumValues as option (option)}
                    <Select.Item value={option}>{option}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            {:else}
              <Input
                class="w-56 font-mono"
                type={member.isSecret ? "password" : "text"}
                placeholder={member.isSecret && overrides[member.key] ? "Stored, enter a value to replace it" : "Not set"}
                value={groupDrafts[group.id]?.[member.key] ?? ""}
                oninput={(event) => setGroupDraft(group, member.key, event.currentTarget.value)}
              />
            {/if}
          </div>
        {/each}

        <div class="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" disabled={busyHere} onclick={() => saveGroup(group)}>Save both</Button>
          {#if managed}
            <Button size="sm" variant="ghost" disabled={busyHere} onclick={() => clearGroup(group)}>
              <RotateCcw class="size-4" />
              Clear
            </Button>
          {/if}
          {#if managed}
            <span class="text-xs text-muted-foreground">Managed from here</span>
          {/if}
        </div>
      </Card.Content>
    </Card.Root>
    {/if}
  {/each}

  {#if settings.length + groups.length === 0}
    <p class="text-sm text-muted-foreground">No settings are declared as dashboard-managed.</p>
  {:else if blocks.length === 0}
    <p class="text-sm text-muted-foreground">Nothing matches that filter.</p>
  {/if}
</div>
