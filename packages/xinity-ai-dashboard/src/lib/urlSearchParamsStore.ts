/**
 * Svelte store that mirrors URL search params and updates history.
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
