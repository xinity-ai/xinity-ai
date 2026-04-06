<script lang="ts">
  import { page } from "$app/stores";

  type T = $$Generic<{ id: string; [any: string]: string | null | number | Date }>;
  export let items: T[] = [];
  export let labels: Record<string, string>;
  // export let items: ({ id: string } & Record<string, string | null | number | Date>)[];
  export let withCheckboxes: boolean = false;

  export let pageIndex: number | undefined = undefined;
  export let pagesAmount: number | undefined = undefined;
  export let itemsAmount: number;

  const intl = new Intl.DateTimeFormat("de-AT", {
    timeStyle: "short",
    dateStyle: "medium",
  });

  let selected: Record<string, boolean> = {};
  $: allSelected = items.every(doc => selected[doc.id]);
  $: someSelected = items.some(doc => selected[doc.id]);

  function modifiedParams(newPage: number, current: URL): string {
    const copy = new URLSearchParams(current.searchParams);
    copy.set("page", String(newPage));
    return copy.toString();
  }
</script>

<div class="border border-gray-200 rounded-lg dark:border-gray-700">
  <div class="overflow-x-auto rounded-t-lg">
    <table
      class="min-w-full text-sm bg-white divide-y-2 divide-gray-200 dark:divide-gray-700 dark:bg-gray-900"
    >
      <thead class="text-left">
        <tr>
          {#if withCheckboxes}
            <th class="px-4 py-2 compact:px-3 compact:py-1">
              <label class="sr-only" for="Row1">Row 1</label>
              <input
                class="border-gray-300 rounded size-5 dark:border-gray-700 dark:bg-gray-800 dark:focus:ring-offset-gray-900"
                type="checkbox"
                id="Row1"
                checked={allSelected}
                indeterminate={!allSelected && someSelected}
                on:change={() => {
                  if (allSelected) {
                    selected = Object.fromEntries(items.map(doc => [doc.id, false]));
                  } else {
                    selected = Object.fromEntries(items.map(doc => [doc.id, true]));
                  }
                }}
              />
            </th>
          {/if}
          {#each Object.values(labels) as label}
            <th class="px-4 py-2 compact:px-3 compact:py-1 font-medium text-gray-900 whitespace-nowrap dark:text-white">
              {label}
            </th>
          {/each}
          {#if $$slots.actions}
            <th class="px-4 py-2 compact:px-3 compact:py-1"></th>
          {/if}
        </tr>
      </thead>

      <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
        {#each items as item, index (item.id)}
          <tr id="doc-{item.id}">
            {#if withCheckboxes}
              <td class="px-4 py-2 compact:px-3 compact:py-1">
                <label class="sr-only" for="Row{index}">Row {index + 1}</label>

                <input
                  class="border-gray-300 rounded size-5 dark:border-gray-700 dark:bg-gray-800 dark:focus:ring-offset-gray-900"
                  type="checkbox"
                  id="Row{index}"
                  bind:checked={selected[item.id]}
                />
              </td>
            {/if}
            {#each Object.keys(labels) as key}
              {@const value = item[key]}
              <td class="px-4 py-2 compact:px-3 compact:py-1 font-medium text-gray-900 whitespace-nowrap dark:text-white">
                {value instanceof Date ? intl.format(value) : String(value ?? "")}
              </td>
            {/each}
            {#if $$slots.actions}
              <td class="flex gap-2 px-4 py-2 compact:px-3 compact:py-1">
                <slot name="actions" {item} />
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if typeof pageIndex == "number" && typeof pagesAmount == "number" && typeof itemsAmount == "number"}
    {@const startingPageIndex = Math.max(0, pageIndex - 2)}
    {@const endingPageIndex = Math.min(pagesAmount, pageIndex + 3)}
    {@const pagesLinksAmount = Math.min(5, endingPageIndex - startingPageIndex)}
    {@const refUrl = $page.url}
    <div
      class="flex justify-between px-4 py-2 compact:px-3 compact:py-1 border-t border-gray-200 rounded-b-lg dark:border-gray-700"
    >
      <span class="">Total: {itemsAmount}</span>
      <ol class="flex justify-end gap-1 text-xs font-medium">
        {#if pageIndex > 0 && startingPageIndex > 0}
          <li>
            <a
              href="?{modifiedParams(0, refUrl)}"
              class="inline-flex items-center justify-center text-gray-900 bg-white border border-gray-100 rounded size-8 compact:size-6 rtl:rotate-180 dark:border-gray-800 dark:bg-gray-900 dark:text-white"
            >
              <span class="sr-only">First Page</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="w-3 h-3"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="m18.75 4.5-7.5 7.5 7.5 7.5m-6-15L5.25 12l7.5 7.5"
                />
              </svg>
            </a>
          </li>
        {/if}
        {#if pageIndex > 0}
          <li>
            <a
              href="?{modifiedParams(pageIndex - 1, refUrl)}"
              class="inline-flex items-center justify-center text-gray-900 bg-white border border-gray-100 rounded size-8 compact:size-6 rtl:rotate-180 dark:border-gray-800 dark:bg-gray-900 dark:text-white"
            >
              <span class="sr-only">Prev Page</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="w-3 h-3"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M15.75 19.5 8.25 12l7.5-7.5"
                />
              </svg>
            </a>
          </li>
        {/if}

        {#each Array(pagesLinksAmount) as page, index}
          {@const pageNumber = startingPageIndex + index}
          {#if pageNumber === pageIndex}
            <li
              class="block leading-8 text-center bg-xinity-purple border-xinity-purple rounded size-8 compact:size-6 compact:leading-6 dark:text-white"
            >
              {pageNumber + 1}
            </li>
          {:else}
            <li>
              <a
                href="?{modifiedParams(pageNumber, refUrl)}"
                class="block leading-8 text-center text-gray-900 bg-white border border-gray-100 rounded size-8 compact:size-6 compact:leading-6 dark:border-gray-800 dark:bg-gray-900 dark:text-white"
              >
                {pageNumber + 1}
              </a>
            </li>
          {/if}
        {/each}

        {#if pageIndex < pagesAmount - 1}
          <li>
            <a
              href="?{modifiedParams(pageIndex + 1, refUrl)}"
              class="inline-flex items-center justify-center text-gray-900 bg-white border border-gray-100 rounded size-8 compact:size-6 rtl:rotate-180 dark:border-gray-800 dark:bg-gray-900 dark:text-white"
            >
              <span class="sr-only">Next Page</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="w-3 h-3"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="m8.25 4.5 7.5 7.5-7.5 7.5"
                />
              </svg>
            </a>
          </li>
        {/if}
        {#if pageIndex < pagesAmount - 1 && endingPageIndex < pagesAmount}
          <li>
            <a
              href="?{modifiedParams(pagesAmount - 1, refUrl)}"
              class="inline-flex items-center justify-center text-gray-900 bg-white border border-gray-100 rounded size-8 compact:size-6 rtl:rotate-180 dark:border-gray-800 dark:bg-gray-900 dark:text-white"
            >
              <span class="sr-only">Final Page</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="w-3 h-3"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="m5.25 4.5 7.5 7.5-7.5 7.5m6-15 7.5 7.5-7.5 7.5"
                />
              </svg>
            </a>
          </li>
        {/if}
      </ol>
    </div>
  {/if}
</div>
