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
  import { Search, RotateCcw } from "@lucide/svelte";
  import { toastState } from "$lib/state/toast.svelte";
  import type { DynamicSettingSummary } from "./dynamic-settings";

  type Override = { value?: string; digest?: string; updatedBy: string | null; updatedAt: string };

  let settings = $state<DynamicSettingSummary[]>([]);
  let overrides = $state<Record<string, Override>>({});
  let drafts = $state<Record<string, string>>({});
  let busy = $state<string | null>(null);
  let query = $state("");
  let onlyManaged = $state(false);

  const managedCount = $derived(settings.filter((setting) => overrides[setting.key]).length);

  const visible = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return settings.filter((setting) => {
      if (onlyManaged && !overrides[setting.key]) {
        return false;
      }
      return !needle || `${setting.key} ${setting.description}`.toLowerCase().includes(needle);
    });
  });

  const groups = $derived.by(() => {
    const byGroup = new Map<string, DynamicSettingSummary[]>();
    for (const setting of visible) {
      const name = setting.group ?? "General";
      byGroup.set(name, [...(byGroup.get(name) ?? []), setting]);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  async function refresh() {
    const { data } = await orpc.dynamicConfig.list({});
    if (!data) {
      return;
    }
    settings = data.settings;
    overrides = Object.fromEntries(data.overrides.map((override) => [override.key, {
      value: override.value,
      digest: override.digest,
      updatedBy: override.updatedBy,
      updatedAt: String(override.updatedAt),
    }]));
    drafts = {};
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
        All {settings.length}
      </Button>
      <Button variant={onlyManaged ? "secondary" : "outline"} size="sm" onclick={() => (onlyManaged = true)}>
        Managed here {managedCount}
      </Button>
    </div>
  </div>

  {#each groups as [groupName, groupSettings] (groupName)}
    <Card.Root>
      <Card.Header class="pb-2">
        <Card.Title class="text-base">{groupName}</Card.Title>
      </Card.Header>
      <Card.Content class="p-0">
        {#each groupSettings as setting (setting.key)}
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
  {/each}

  {#if settings.length === 0}
    <p class="text-sm text-muted-foreground">No settings are declared as dashboard-managed.</p>
  {:else if visible.length === 0}
    <p class="text-sm text-muted-foreground">Nothing matches that filter.</p>
  {/if}
</div>
