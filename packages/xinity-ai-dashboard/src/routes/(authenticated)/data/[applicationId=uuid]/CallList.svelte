<script lang="ts">
  import type { ApiCall, ApiCallResponse } from "common-db";
  import type { ApiCallReactionSummary } from "./data.remote";
  import { messageContentToString } from "./data.utils";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { ThumbsUp, ThumbsDown, Loader2 } from "@lucide/svelte";

  let {
    calls = [],
    selectedCallId = null,
    formatDate,
    onSelect = () => {},
    onLoadMore = () => {},
    loadingMore = false,
    hasMore = true,
    totalCount = null as number | null,
    getReactionSummary,
    getUserResponse,
  }: {
    calls?: ApiCall[];
    selectedCallId?: string | null;
    formatDate: (date: Date) => string;
    onSelect?: (call: ApiCall) => void;
    onLoadMore?: () => void;
    loadingMore?: boolean;
    hasMore?: boolean;
    totalCount?: number | null;
    getReactionSummary: (callId: string) => ApiCallReactionSummary;
    getUserResponse: (callId: string) => ApiCallResponse | null;
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

  function startOfPrompt(call: ApiCall) {
    const first = call.inputMessages?.[0];
    if (!first) return "";
    return messageContentToString(first.content);
  }

  function reactionSummaryFor(callId: string) {
    return (
      getReactionSummary?.(callId) ?? {
        apiCallId: callId,
        likes: 0,
        dislikes: 0,
        total: 0,
      }
    );
  }

  function userResponseFor(callId: string) {
    return getUserResponse?.(callId) ?? null;
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
      </Card.Description>
    </Card.Header>
    <Card.Content class="p-0">
      <div bind:this={scrollContainerEl} class="overflow-y-auto" style="max-height: 700px;">
        {#if calls.length > 0}
          <div role="list">
            {#each calls as call (call.id)}
              {@const summary = reactionSummaryFor(call.id)}
              {@const userResponse = userResponseFor(call.id)}
              <div
                role="listitem"
                class:selected={selectedCallId === call.id}
                class="p-4 compact:p-2 border-b call-item"
              >
                <button
                  class="w-full text-left cursor-pointer"
                  onclick={() => onSelect(call)}
                  onkeydown={(e) => e.key === "Enter" && onSelect(call)}
                  aria-pressed={selectedCallId === call.id}
                >
                  <div class="flex items-center justify-between">
                    <span class="font-medium truncate">{call.model}</span>
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
                    <span>{(call.duration / 1000).toFixed(1)}s</span>
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
                </button>
              </div>
            {/each}
          </div>
          {#if hasMore}
            <div bind:this={sentinelEl} class="flex items-center justify-center p-4">
              {#if loadingMore}
                <Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
              {/if}
            </div>
          {/if}
        {:else}
          <div class="p-6 text-center text-muted-foreground">
            No calls found matching your search criteria.
          </div>
        {/if}
      </div>
    </Card.Content>
  </Card.Root>
</div>
