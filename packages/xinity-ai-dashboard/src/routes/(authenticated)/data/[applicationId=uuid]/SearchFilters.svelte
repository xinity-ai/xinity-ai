<script lang="ts">
  import type { PartialPublicApiKey } from "./data.remote";
  import * as Select from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import { Filter } from "@lucide/svelte";

  let {
      searchQuery = $bindable(""),
      sortOption = $bindable("newest"),
      apiKeyFilter = $bindable("all"),
      reactionFilter = $bindable("all"),
      metadataKey = $bindable(""),
      metadataValue = $bindable(""),
      apiKeys = [],
  }: {
    searchQuery?: string;
    sortOption?: string;
    apiKeyFilter?: string;
    reactionFilter?: string;
    metadataKey?: string;
    metadataValue?: string;
    apiKeys?: PartialPublicApiKey[];
  } = $props();

  let showMetadataFilter = $state(false);

  const sortLabels: Record<string, string> = {
    newest: "Newest First",
    oldest: "Oldest First",
    duration: "Duration (Longest First)",
  };

  const reactionOptions = [
    { value: "all", label: "All Reactions" },
    { value: "has-reactions", label: "Has Reactions" },
    { value: "no-reactions", label: "No Reactions" },
    { value: "likes", label: "Liked" },
    { value: "dislikes", label: "Disliked" },
    { value: "my-reactions", label: "My Reactions" },
    { value: "my-liked", label: "My Likes" },
    { value: "my-disliked", label: "My Dislikes" },
  ];

  const apiKeyLabel = $derived(
    apiKeyFilter === "all"
      ? "All API Keys"
      : apiKeys.find((key) => key.id === apiKeyFilter)?.name || "Select API Key",
  );

  const sortLabel = $derived(sortLabels[sortOption] || "Sort by");
  const reactionLabel = $derived(
    reactionOptions.find((option) => option.value === reactionFilter)?.label ||
      "All Reactions",
  );
</script>

<div class="flex flex-col gap-4 mb-6 md:flex-row md:items-center">
  <div class="grow">
    <Input
      type="text"
      bind:value={searchQuery}
      placeholder="Search prompts and responses..."
    />
  </div>
  <div class="flex shrink-0 flex-wrap gap-2">
    <Select.Root type="single" bind:value={apiKeyFilter}>
      <Select.Trigger class="min-w-42.5">
        {apiKeyLabel}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="all" label="All API Keys" />
        {#each apiKeys as key}
          <Select.Item value={key.id} label={key.name} />
        {/each}
      </Select.Content>
    </Select.Root>

    <Select.Root type="single" bind:value={sortOption}>
      <Select.Trigger class="min-w-47.5">
        {sortLabel}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="newest" label="Newest First" />
        <Select.Item value="oldest" label="Oldest First" />
        <Select.Item value="duration" label="Duration (Longest First)" />
      </Select.Content>
    </Select.Root>

    <Select.Root type="single" bind:value={reactionFilter}>
      <Select.Trigger class="min-w-42.5">
        {reactionLabel}
      </Select.Trigger>
      <Select.Content>
        {#each reactionOptions as option}
          <Select.Item value={option.value} label={option.label} />
        {/each}
      </Select.Content>
    </Select.Root>

    <Button
      variant={showMetadataFilter || metadataKey ? "secondary" : "outline"}
      size="sm"
      onclick={() => (showMetadataFilter = !showMetadataFilter)}
      title="Filter by metadata"
    >
      <Filter class="w-4 h-4" />
      Metadata
    </Button>
  </div>
</div>

{#if showMetadataFilter}
  <div class="flex flex-wrap items-end gap-2 mb-6 -mt-2">
    <div class="flex gap-2">
      <Input
        type="text"
        bind:value={metadataKey}
        placeholder="Key (e.g. env)"
        class="w-40"
      />
      <Input
        type="text"
        bind:value={metadataValue}
        placeholder="Value (e.g. prod)"
        class="w-40"
      />
    </div>
    {#if metadataKey || metadataValue}
      <Button
        variant="ghost"
        size="sm"
        onclick={() => { metadataKey = ""; metadataValue = ""; }}
      >
        Clear
      </Button>
    {/if}
  </div>
{/if}
