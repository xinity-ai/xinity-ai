<script lang="ts">
  import type { ApiCallResponse } from "common-db";
  import type { ApiCallReactionSummary, DataViewCall } from "./data.remote";
  import { messageContentToString } from "./data.utils";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { ThumbsUp, ThumbsDown, LoaderCircle } from "@lucide/svelte";

  let {
    calls = [],
    loading = false,
    selectedCallId = null,
    formatDate,
    onSelect = () => {},
    onLoadMore = () => {},
    loadingMore = false,
    hasMore = true,
    totalCount = null as number | null,
    getReactionSummary,
    getUserResponse,
    showSelect = false,
    selectedCallIds = new Set<string>(),
    onSelectToggle = () => {},
    onSelectAll = (_checked: boolean) => {},
  }: {
    calls?: DataViewCall[];
    loading?: boolean;
    selectedCallId?: string | null;
    formatDate: (date: Date) => string;
    onSelect?: (call: DataViewCall) => void;
    onLoadMore?: () => void;
    loadingMore?: boolean;
    hasMore?: boolean;
    totalCount?: number | null;
    getReactionSummary: (callId: string) => ApiCallReactionSummary;
    getUserResponse: (callId: string) => ApiCallResponse | null;
    showSelect?: boolean;
    selectedCallIds?: Set<string>;
    onSelectToggle?: (callId: string, checked: boolean) => void;
    onSelectAll?: (checked: boolean) => void;
  } = $props();

  let sentinelEl = $state<HTMLDivElement | null>(null);
  let scrollContainerEl = $state<HTMLDivElement | null>(null);
  let loadTriggered = $state(false);

  $effect(() => {
    if (!loadingMore && loadTriggered) {
      const timer = setTimeout(() => { loadTriggered = false; }, 150);
      return () => clearTimeout(timer);
    }
  });

  $effect(() => {
    if (!sentinelEl || !scrollContainerEl) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingMore && !loadTriggered) {
          loadTriggered = true;
          onLoadMore();
        }
      },
      { root: scrollContainerEl, rootMargin: "200px" },
    );
    observer.observe(sentinelEl);
    return () => observer.disconnect();
  });

  function startOfPrompt(call: DataViewCall) {
    const first = call.inputMessages?.[0];
    if (!first) return "";
    return messageContentToString(first.content);
  }
</script>

<div class="lg:col-span-1">
  <Card.Root>
    <Card.Header class="border-b bg-muted/50">
      <Card.Title class="text-base">Recent API Calls</Card.Title>
      <Card.Description>
        {#if totalCount != null}
          Showing {calls.length} of {totalCount} calls{hasMore ? " (scroll for more)" : ""}
        {:else}
          Showing {calls.length} calls{hasMore ? " (scroll for more)" : ""}
        {/if}
        {#if showSelect && selectedCallIds.size > 0}
          <span class="text-xs font-medium text-primary ml-1">
            · {selectedCallIds.size} selected
          </span>
        {/if}
      </Card.Description>
    </Card.Header>
    <Card.Content class="p-0">
      <div bind:this={scrollContainerEl} class="overflow-y-auto" style="max-height: 700px;">
        {#if calls.length > 0}
          <div role="list">
            {#if showSelect}
              <div class="p-4 compact:p-2 border-b bg-muted/30 border-l-3 border-l-transparent">
                <div class="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="select-all"
                    checked={calls.every(c => selectedCallIds.has(c.id)) && calls.length > 0}
                    indeterminate={selectedCallIds.size > 0 && !calls.every(c => selectedCallIds.has(c.id))}
                    onchange={(e) => onSelectAll(e.currentTarget.checked)}
                    class="w-4 h-4 shrink-0"
                  />
                  <label for="select-all" class="text-xs text-muted-foreground">Select all on page</label>
                </div>
              </div>
            {/if}
            {#each calls as call (call.id)}
              {@const summary = getReactionSummary(call.id)}
              {@const userResponse = getUserResponse(call.id)}
              <div
                role="listitem"
                class:selected={selectedCallId === call.id}
                class="relative p-4 compact:p-2 border-b call-item"
              >
                <button
                  class="absolute inset-0 cursor-pointer"
                  onclick={() => onSelect(call)}
                  aria-pressed={selectedCallId === call.id}
                  aria-label="View call {call.servedModel}"
                ></button>
                <div class="flex items-start gap-3 pointer-events-none">
                  {#if showSelect}
                    <input
                      type="checkbox"
                      checked={selectedCallIds.has(call.id)}
                      onchange={(e) => onSelectToggle(call.id, e.currentTarget.checked)}
                      onclick={(e) => e.stopPropagation()}
                      class="w-4 h-4 shrink-0 mt-1 pointer-events-auto"
                    />
                  {/if}
                  <div class="flex-1 text-left">
                    <div class="flex items-center justify-between">
                      <span class="font-medium truncate">{call.servedModel}</span>
                      <span class="text-xs text-muted-foreground">{formatDate(call.createdAt)}</span>
                    </div>
                    <p class="mt-1 text-sm text-muted-foreground line-clamp-2">
                      {startOfPrompt(call)}
                    </p>
                    <div class="flex items-center mt-2 text-xs text-muted-foreground">
                      <span class="flex items-center mr-3">
                        <span class="status-indicator status-completed"></span>
                        complete
                      </span>
                      <span>{(call.durationMs / 1000).toFixed(1)}s</span>
                    </div>
                    <div class="flex flex-wrap items-center gap-2 mt-2 text-xs text-muted-foreground">
                      {#if summary.total > 0}
                        <span class="flex items-center gap-1">
                          <ThumbsUp class="w-3 h-3" />
                          <span>{summary.likes}</span>
                        </span>
                        <span class="flex items-center gap-1">
                          <ThumbsDown class="w-3 h-3" />
                          <span>{summary.dislikes}</span>
                        </span>
                        <span class="text-muted-foreground/70">
                          ({summary.total} reacted)
                        </span>
                      {:else}
                        <span class="text-muted-foreground/70">No reactions yet</span>
                      {/if}
                      {#if userResponse?.response === true}
                        <Badge variant="secondary" class="text-[10px] px-1.5 py-0">
                          You liked
                        </Badge>
                      {:else if userResponse?.response === false}
                        <Badge variant="secondary" class="text-[10px] px-1.5 py-0">
                          You disliked
                        </Badge>
                      {/if}
                    </div>
                  </div>
                </div>
              </div>
            {/each}
          </div>
          {#if hasMore}
            <div bind:this={sentinelEl} class="flex items-center justify-center p-4">
              {#if loadingMore}
                <LoaderCircle class="w-5 h-5 animate-spin text-muted-foreground" />
              {/if}
            </div>
          {/if}
        {:else}
          <div class="p-6 flex flex-col items-center justify-center text-muted-foreground">
            {#if loading}
              <LoaderCircle class="w-5 h-5 animate-spin mb-2" />
              Loading calls...
            {:else}
              No calls found matching your search criteria.
            {/if}
          </div>
        {/if}
      </div>
    </Card.Content>
  </Card.Root>
</div>
