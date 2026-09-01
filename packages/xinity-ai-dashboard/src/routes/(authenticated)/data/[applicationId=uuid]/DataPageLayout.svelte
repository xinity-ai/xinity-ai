<script lang="ts">
  import CallDetails from "./CallDetails.svelte";
  import CallList from "./CallList.svelte";
  import SearchFilters from "./SearchFilters.svelte";
  import BatchActionBar from "./BatchActionBar.svelte";
  import "./data.css";
  import {
    deleteApiCall,
    getAPICallResponse,
    getApiCallReactionSummary,
    getApiCalls,
    getApiCallCount,
    getApiKeys,
    type ApiCallReactionSummary,
    type DataViewCall,
  } from "./data.remote";
  import type { ApiCallResponse } from "common-db";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { permissions } from "$lib/state/permissions.svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { untrack } from "svelte";
  import { useDebouncedValue } from "$lib/state/debounced.svelte";
  import { Button } from "$lib/components/ui/button";
  import { ArrowLeft, BookOpen } from "@lucide/svelte";
  import { humanDate } from "$lib/util";

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
  let selectedCall: DataViewCall | null = $state(null);
  let deleteTarget = $state<DataViewCall | null>(null);
  let deleteModalOpen = $state(false);
  let deleting = $state(false);
  let selectedCallIds = $state(new Set<string>());

  function toggleSelectCall(callId: string, checked: boolean) {
    const next = new Set(selectedCallIds);
    if (checked) {
      next.add(callId);
    } else {
      next.delete(callId);
    }
    selectedCallIds = next;
  }

  function handleSelectAll(checked: boolean) {
    const next = new Set(selectedCallIds);
    for (const call of filteredCalls) {
      if (call.source === "legacy") {
        continue;
      }
      if (checked) {
        next.add(call.id);
      } else {
        next.delete(call.id);
      }
    }
    selectedCallIds = next;
  }

  function clearSelection() {
    selectedCallIds = new Set();
  }

  let allCalls = $state<DataViewCall[]>([]);
  let offset = $state(0);
  let loadingMore = $state(false);
  let hasMore = $state(true);

  const debouncedSearch = useDebouncedValue(() => searchQuery, 300);

  // Build a filter key to detect when server-side filters change
  const filterKey = $derived(
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
  let deletedCount = $state(0);
  const totalCount = $derived(apiCallCount.current != null ? apiCallCount.current - deletedCount : null);

  // Reset pagination when server-side filters change
  $effect(() => {
    const key = filterKey;
    if (key !== prevFilterKey) {
      prevFilterKey = key;
      offset = 0;
      allCalls = [];
      deletedCount = 0;
      reactionSummaryRequests = new Map();
      responseRequests = new Map();
      hasMore = true;
      clearSelection();
    }
  });

  // Accumulate results when query data arrives
  $effect(() => {
    const data = apiCalls.current;
    if (!data) return;
    if (offset === 0) {
      allCalls = data;
    } else {
      // untracked: this effect writes allCalls, so tracking the read would cycle
      const existing = untrack(() => allCalls);
      const existingIds = new Set(existing.map((c) => c.id));
      const newCalls = data.filter((c) => !existingIds.has(c.id));
      allCalls = [...existing, ...newCalls];
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
  const apiKeyNameMap = $derived(
    new Map((apiKeys.current || []).map((key) => [key.id, key.name])),
  );
  let applications = $state<{ id: string; name: string }[]>([]);
  if (permissions.can("apiCall", "update")) {
    orpc.application.list().then(([error, data]) => {
      if (!error && data) {
        applications = data.map((a) => ({ id: a.id, name: a.name }));
      }
    });
  }
  const filteredCalls = $derived(getFilteredCalls(allCalls));

  function handleBatchRemoved(ids: string[], reassigned: number) {
    if (reassigned === 0) {
      return;
    }
    const removed = new Set(ids);
    allCalls = allCalls.filter((c) => !removed.has(c.id));
    deletedCount += reassigned;
    if (selectedCall && removed.has(selectedCall.id)) {
      selectedCall = null;
    }
  }

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

  function getFilteredCalls(calls: DataViewCall[]) {
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

  function selectCall(call: DataViewCall) {
    selectedCall = call;
  }

  function loadMoreData() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    offset = allCalls.length;
  }

  function requestDelete(call: DataViewCall) {
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
        deletedCount++;
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
      loading={apiCalls.loading && allCalls.length === 0}
      selectedCallId={selectedCall ? selectedCall.id : null}
      formatDate={humanDate}
      onSelect={selectCall}
      onLoadMore={loadMoreData}
      {loadingMore}
      {hasMore}
      {totalCount}
      getReactionSummary={getReactionSummary}
      getUserResponse={getUserResponse}
      showSelect={permissions.can("apiCall", "delete") || permissions.can("apiCall", "update")}
      selectedCallIds={selectedCallIds}
      onSelectToggle={toggleSelectCall}
      onSelectAll={handleSelectAll}
    />

    <div class="lg:col-span-2">
      <CallDetails
        call={selectedCall}
        {apiKeyNameMap}
        formatDate={humanDate}
        onDelete={requestDelete}
        canDelete={permissions.can("apiCall", "delete")}
        canUpdate={permissions.can("apiCall", "update")}
      />
    </div>
  </div>
</div>

<BatchActionBar
  {selectedCallIds}
  {applications}
  canMove={permissions.can("apiCall", "update")}
  onClear={clearSelection}
  onMoved={handleBatchRemoved}
/>

<ConfirmDialog
  bind:open={deleteModalOpen}
  title="Delete API call?"
  description="This will permanently remove the call and its reactions. This action cannot be undone."
  confirmLabel={deleting ? "Deleting..." : "Delete Call"}
  onConfirm={() => void confirmDelete()}
  onCancel={closeDeleteModal}
>
  {#if deleteTarget}
    <div class="rounded border bg-muted/50 p-3 text-xs">
      <div class="font-semibold">Call ID</div>
      <div class="break-all text-muted-foreground">{deleteTarget.id}</div>
    </div>
  {/if}
</ConfirmDialog>
