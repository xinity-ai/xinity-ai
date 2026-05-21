/**
 * Svelte store that mirrors URL search params and updates history via pushState
 * (no SvelteKit navigation/load cycle).
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { createUrlSearchParamsStore } from "$lib/urlSearchParamsStore";
 *
 *   const searchParams = createUrlSearchParamsStore();
 *
 *   // Read values (reactive)
 *   const currentPage = $derived(Number($searchParams.page) || 1);
 *   const search = $derived($searchParams.search ?? "");
 *
 *   // Set a single param
 *   $searchParams.page = "2";
 *
 *   // Remove a param
 *   delete $searchParams.page;
 *
 *   // Use in an input (with debounce for search)
 *   function onSearchInput(e: Event) {
 *     clearTimeout(timeout);
 *     timeout = setTimeout(() => {
 *       $searchParams.search = (e.target as HTMLInputElement).value;
 *       delete $searchParams.page; // reset to page 1
 *       void fetchData();
 *     }, 300);
 *   }
 * ```
 *
 * All values are strings (matching URLSearchParams behavior).
 * Empty strings are stripped from the URL automatically.
 */
import { type Writable, writable } from "svelte/store";
import { browser } from "$app/environment";
import { page } from "$app/state";
import { pushState } from "$app/navigation";

/**
 * Creates a writable store backed by the current URL search params.
 */
export function createUrlSearchParamsStore(): Writable<Record<string, string>> {
  if (!browser) {
    return writable(Object.fromEntries(page.url.searchParams.entries()));
  }
  const getParamsObject = () =>
    Object.fromEntries(new URLSearchParams(window.location.search).entries());

  const setUrlFromParams = (paramsObj: Record<string, string>) => {
    const url = new URL(window.location.href);
    url.search = "";
    for (const [key, value] of Object.entries(paramsObj)) {
      if (value != null && value !== "") {
        url.searchParams.set(key, value);
      }
    }
    pushState(url.pathname + url.search + url.hash, {});
  };

  const { subscribe, set } = writable(getParamsObject(), (set) => {
    const onPopState = () => set(getParamsObject());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  let pendingUpdate: Record<string, string> | null = null;

  const flush = () => {
    if (pendingUpdate) {
      setUrlFromParams(pendingUpdate);
      set(getParamsObject());
      pendingUpdate = null;
    }
  };

  return {
    subscribe,
    set: (value: Record<string, string>) => {
      pendingUpdate = value;
      set(value); // update subscribers immediately for responsive UI
      queueMicrotask(flush);
    },
    update: (updater) => {
      const current = pendingUpdate ?? getParamsObject();
      const updated = updater(current);
      pendingUpdate = updated;
      set(updated);
      queueMicrotask(flush);
    },
  } as Writable<Record<string, string>>;
}