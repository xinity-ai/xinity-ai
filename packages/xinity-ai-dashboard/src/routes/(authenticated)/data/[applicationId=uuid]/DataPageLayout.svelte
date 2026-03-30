<script lang="ts">
  import CallDetails from "./CallDetails.svelte";
  import CallList from "./CallList.svelte";
  import SearchFilters from "./SearchFilters.svelte";
  import "./data.css";
  import {
    deleteApiCall,
    getAPICallResponse,
    getApiCallReactionSummary,
    getApiCalls,
    getApiCallCount,
    getApiKeys,
    type ApiCallReactionSummary,
  } from "./data.remote";
  import type { ApiCall, ApiCallResponse } from "common-db";
  import Modal from "$lib/components/Modal.svelte";
  import { permissions } from "$lib/state/permissions.svelte";
  import { useDebouncedValue } from "$lib/state/debounced.svelte";
  import { Button } from "$lib/components/ui/button";
  import { ArrowLeft, BookOpen } from "@lucide/svelte";

  type SortOption = "newest" | "oldest" | "duration";
  type ReactionFilter =
    | "all"
    | "has-reactions"
    | "no-reactions"
    | "likes"
    | "dislikes"
    | "my-reactions"
    | "my-liked"
    | "my-disliked";

  const PAGE_SIZE = 50;

  let {
    applicationId,
    title,
    description,
  }: {
    applicationId: string | null;
    title: string;
    description: string;
  } = $props();

  let searchQuery = $state("");
  let sortOption: SortOption = $state("newest");
  let apiKeyFilter = $state("all");
  let reactionFilter: ReactionFilter = $state("all");
  let metadataKey = $state("");
  let metadataValue = $state("");
  let selectedCall: ApiCall | null = $state(null);
  let deleteTarget = $state<ApiCall | null>(null);
  let deleteModalOpen = $state(false);
  let deleting = $state(false);

  let allCalls = $state<ApiCall[]>([]);
  let offset = $state(0);
  let loadingMore = $state(false);
  let hasMore = $state(true);

  const debouncedSearch = useDebouncedValue(() => searchQuery, 300);

  // Build a filter key to detect when server-side filters change
  let filterKey = $derived(
    `${applicationId}|${apiKeyFilter}|${sortOption}|${metadataKey}|${metadataValue}|${debouncedSearch.current}`,
  );
  let prevFilterKey = $state("");

  const apiCalls = $derived(
    getApiCalls({
      applicationId,
      apiKeyId: apiKeyFilter === "all" ? undefined : apiKeyFilter,
      sortOption,
      metadataKey: metadataKey || undefined,
      metadataValue: metadataValue || undefined,
      searchQuery: debouncedSearch.current || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
  );

  const apiCallCount = $derived(
    getApiCallCount({
      applicationId,
      apiKeyId: apiKeyFilter === "all" ? undefined : apiKeyFilter,
      metadataKey: metadataKey || undefined,
      metadataValue: metadataValue || undefined,
      searchQuery: debouncedSearch.current || undefined,
    }),
  );
  let totalCount = $derived(apiCallCount.current ?? null);

  // Reset pagination when server-side filters change
  $effect(() => {
    const key = filterKey;
    if (key !== prevFilterKey) {
      prevFilterKey = key;
      offset = 0;
      allCalls = [];
      reactionSummaryRequests = new Map();
      responseRequests = new Map();
      hasMore = true;
    }
  });

  // Accumulate results when query data arrives
  $effect(() => {
    const data = apiCalls.current;
    if (!data) return;
    if (offset === 0) {
      allCalls = data;
    } else {
      // Deduplicate in case of overlapping fetches
      const existingIds = new Set(allCalls.map((c) => c.id));
      const newCalls = data.filter((c) => !existingIds.has(c.id));
      allCalls = [...allCalls, ...newCalls];
    }
    hasMore = data.length >= PAGE_SIZE;
    loadingMore = false;
  });

  let reactionSummaryRequests = $state(new Map<string, ReturnType<typeof getApiCallReactionSummary>>());
  let responseRequests = $state(new Map<string, ReturnType<typeof getAPICallResponse>>());

  $effect(() => {
    for (const call of allCalls) {
      if (!reactionSummaryRequests.has(call.id)) {
        reactionSummaryRequests.set(call.id, getApiCallReactionSummary(call.id));
      }
      if (!responseRequests.has(call.id)) {
        responseRequests.set(call.id, getAPICallResponse(call.id));
      }
    }
  });
  const apiKeys = $derived(getApiKeys({ applicationId }));
  let apiKeyNameMap = $derived(
    new Map((apiKeys.current || []).map((key) => [key.id, key.name])),
  );
  let filteredCalls = $derived(getFilteredCalls(allCalls));

  function getReactionSummary(callId: string): ApiCallReactionSummary {
    return (
      reactionSummaryRequests.get(callId)?.current ?? {
        apiCallId: callId,
        likes: 0,
        dislikes: 0,
        total: 0,
      }
    );
  }

  function getUserResponse(callId: string): ApiCallResponse | null {
    return responseRequests.get(callId)?.current ?? null;
  }

  function getFilteredCalls(calls: ApiCall[]) {
    if (reactionFilter === "all") return calls;
    return calls.filter((call) => {
      const reactionSummary = getReactionSummary(call.id);
      const userResponse = getUserResponse(call.id);
      const userRating =
        userResponse?.response === true
          ? "liked"
          : userResponse?.response === false
            ? "disliked"
            : null;
      return (
        (reactionFilter === "has-reactions" && reactionSummary.total > 0) ||
        (reactionFilter === "no-reactions" && reactionSummary.total === 0) ||
        (reactionFilter === "likes" && reactionSummary.likes > 0) ||
        (reactionFilter === "dislikes" && reactionSummary.dislikes > 0) ||
        (reactionFilter === "my-reactions" && userRating !== null) ||
        (reactionFilter === "my-liked" && userRating === "liked") ||
        (reactionFilter === "my-disliked" && userRating === "disliked")
      );
    });
  }

  function formatDate(date: Date) {
    return date.toLocaleString("de-AT");
  }

  function selectCall(call: ApiCall) {
    selectedCall = call;
  }

  function loadMoreData() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    offset = allCalls.length;
  }

  function requestDelete(call: ApiCall) {
    deleteTarget = call;
    deleteModalOpen = true;
  }

  function closeDeleteModal() {
    deleteModalOpen = false;
    deleteTarget = null;
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    deleting = true;
    try {
      const result = await deleteApiCall({ apiCallId: deleteTarget.id });
      if (result?.success) {
        allCalls = allCalls.filter((c) => c.id !== deleteTarget!.id);
        if (selectedCall?.id === deleteTarget.id) {
          selectedCall = null;
        }
      }
    } finally {
      deleting = false;
      closeDeleteModal();
    }
  }
</script>

<div class="p-6 compact:p-3">
  <div class="flex items-center gap-4 mb-6 compact:gap-2 compact:mb-3">
    <Button
      variant="outline"
      size="icon"
      href="/data"
      title="Back to applications"
    >
      <ArrowLeft class="w-5 h-5" />
    </Button>
    <div>
      <h1 class="text-3xl compact:text-2xl font-bold">{title}</h1>
      <p class="text-muted-foreground">
        {description}
      </p>
    </div>
    <a
      href="/docs/labeling-guide"
      class="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      <BookOpen class="w-4 h-4" />
      Labeling Guide
    </a>
  </div>

  <SearchFilters
    bind:searchQuery
    bind:sortOption
    bind:apiKeyFilter
    bind:reactionFilter
    bind:metadataKey
    bind:metadataValue
    apiKeys={apiKeys.current || []}
  />

  <div class="grid grid-cols-1 gap-6 compact:gap-3 lg:grid-cols-3">
    <CallList
      calls={filteredCalls}
      selectedCallId={selectedCall ? selectedCall.id : null}
      {formatDate}
      onSelect={selectCall}
      onLoadMore={loadMoreData}
      {loadingMore}
      {hasMore}
      {totalCount}
      getReactionSummary={getReactionSummary}
      getUserResponse={getUserResponse}
    />

    <div class="lg:col-span-2">
      <CallDetails
        call={selectedCall}
        {apiKeyNameMap}
        {formatDate}
        onDelete={requestDelete}
        canDelete={permissions.can("apiCall", "delete")}
      />
    </div>
  </div>
</div>

<Modal bind:open={deleteModalOpen} onClose={closeDeleteModal}>
  <div class="w-full max-w-md rounded-xl bg-card p-6 shadow-2xl space-y-4">
    <div>
      <h2 class="text-lg font-semibold">Delete API call?</h2>
      <p class="mt-2 text-sm text-muted-foreground">
        This will permanently remove the call and its reactions. This action
        cannot be undone.
      </p>
    </div>
    {#if deleteTarget}
      <div class="rounded border bg-muted/50 p-3 text-xs">
        <div class="font-semibold">Call ID</div>
        <div class="break-all text-muted-foreground">{deleteTarget.id}</div>
      </div>
    {/if}
    <div class="flex justify-end gap-2">
      <Button
        variant="outline"
        onclick={closeDeleteModal}
        disabled={deleting}
      >
        Cancel
      </Button>
      <Button
        variant="destructive"
        onclick={confirmDelete}
        disabled={deleting}
      >
        {deleting ? "Deleting..." : "Delete Call"}
      </Button>
    </div>
  </div>
</Modal>
