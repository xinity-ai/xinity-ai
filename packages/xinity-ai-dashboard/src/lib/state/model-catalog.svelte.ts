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

export const modelCatalog = {
  get models() { return models; },
  get isLoading() { return isLoading; },
  get loadError() { return loadError; },
  get totalCount() { return totalCount; },
  get initialLoaded() { return initialLoaded; },
  get hasMore() { return !initialLoaded || models.length < totalCount; },

  async loadMore() {
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
  },
};
