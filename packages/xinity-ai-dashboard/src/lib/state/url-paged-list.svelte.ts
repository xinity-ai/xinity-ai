import { untrack } from "svelte";
import { fromStore } from "svelte/store";
import { createUrlSearchParamsStore } from "$lib/urlSearchParamsStore";
import { useDebouncedValue } from "./debounced.svelte";

type PageQuery = { page: number; limit: number; search: string | undefined };
type PageResult<T> = { items: T[]; total: number };

const SEARCH_DEBOUNCE_MS = 300;

export function createUrlPagedList<T>(
  limit: number,
  fetchPage: (query: PageQuery) => Promise<PageResult<T> | null>,
) {
  const searchParams = createUrlSearchParamsStore();
  const params = fromStore(searchParams);
  const currentPage = $derived(Number(params.current.page) || 1);
  const search = $derived(params.current.search ?? "");

  let items = $state<T[]>([]);
  let total = $state(0);
  let searchInput = $state(untrack(() => search));
  const debouncedSearch = useDebouncedValue(() => searchInput, SEARCH_DEBOUNCE_MS);
  let latestRequest = 0;

  async function load(page: number, query: string) {
    const request = ++latestRequest;
    const result = await fetchPage({ page, limit, search: query || undefined });
    if (request !== latestRequest || !result) {
      return;
    }
    items = result.items;
    total = result.total;
  }

  $effect(() => {
    void load(currentPage, search);
  });

  $effect(() => {
    const typed = debouncedSearch.current;
    if (typed === untrack(() => search)) {
      return;
    }
    searchParams.update(({ page: _page, ...rest }) => ({ ...rest, search: typed }));
  });

  // Back/Forward moves the URL search without the input, so the input follows it.
  $effect(() => {
    const fromUrl = search;
    if (fromUrl !== untrack(() => debouncedSearch.current)) {
      searchInput = fromUrl;
    }
  });

  return {
    get items() {
      return items;
    },
    get total() {
      return total;
    },
    get totalPages() {
      return Math.ceil(total / limit);
    },
    get currentPage() {
      return currentPage;
    },
    get searchInput() {
      return searchInput;
    },
    set searchInput(value: string) {
      searchInput = value;
    },
    goToPage(page: number) {
      searchParams.update((current) => ({ ...current, page: String(page) }));
    },
    refresh() {
      return load(currentPage, search);
    },
  };
}
