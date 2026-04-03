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
  const getParamsObject = () => {
    const params = new URLSearchParams(window.location.search);
    const obj: Record<string, string> = {};
    for (const [key, value] of params.entries()) {
      obj[key] = value;
    }
    return obj;
  };

  const setUrlFromParams = (paramsObj: Record<string, string>) => {
    const url = new URL(window.location.href);
    url.search = "";
    for (const key in paramsObj) {
      if (paramsObj[key] != null && paramsObj[key] !== "") {
        url.searchParams.set(key, paramsObj[key]);
      }
    }
    pushState(url.pathname + url.search + url.hash, {});
  };

  const { subscribe, set } = writable(getParamsObject(), set => {
    const onPopState = () => set(getParamsObject());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  return {
    subscribe,
    set: (value: Record<string, string>) => {
      setUrlFromParams(value);
      // Update store subscribers after URL change
      // so $store always matches the URL
      const params = getParamsObject();
      set(params);
    },
    update: updater => {
      const current = getParamsObject();
      const updated = updater(current);
      setUrlFromParams(updated);
      const params = getParamsObject();
      set(params);
    },
  } as Writable<Record<string, string>>;
}
