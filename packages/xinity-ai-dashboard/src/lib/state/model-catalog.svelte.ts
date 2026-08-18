import { browser } from "$app/environment";
import type { ModelWithSpecifier } from "xinity-infoserver";
import { orpc } from "$lib/orpc/orpc-client";

const PAGE_SIZE = 50;

let models = $state<ModelWithSpecifier[]>([]);
let currentPage = $state(1);
let totalCount = $state(0);
let initialLoaded = $state(false);
let isLoading = $state(false);
let loadError = $state<string | null>(null);

async function fetchNextPage() {
  if (!browser || isLoading) return;
  if (initialLoaded && models.length >= totalCount) return;
  isLoading = true;
  loadError = null;
  const [error, data] = await orpc.model.list({ page: currentPage, pageSize: PAGE_SIZE });
  isLoading = false;
  if (error) {
    loadError = error.message;
    return;
  }
  if (data) {
    models = [...models, ...data.models];
    totalCount = data.total;
    currentPage += 1;
    initialLoaded = true;
  }
}

export const modelCatalog = {
  get models() { return models; },
  get isLoading() { return isLoading; },
  get loadError() { return loadError; },
  get totalCount() { return totalCount; },
  get initialLoaded() { return initialLoaded; },
  get hasMore() { return !initialLoaded || models.length < totalCount; },

  /**
   * Automatic callers only. A failure leaves isLoading false and initialLoaded false,
   * which is exactly the state an effect watching those re-fires on, so without the
   * standing error the retry rate is the round-trip time of a refused connection.
   */
  async loadMore() {
    if (loadError) return;
    await fetchNextPage();
  },

  async retry() {
    loadError = null;
    await fetchNextPage();
  },
};
