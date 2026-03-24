<script lang="ts" context="module">
  export type MarkedDetail = { marked: string };
  export const markedDetail = (marked: string) => ({ marked } as MarkedDetail);
</script>

<script lang="ts">
  import Marked from "./Marked.svelte";

  export let data: Record<string, string | number | URL | MarkedDetail | undefined | null>;
</script>

<div class="flow-root">
  <dl class="-my-3 compact:-my-1 text-sm divide-y divide-gray-100 dark:divide-gray-700">
    {#each Object.keys(data).filter(k => data[k] != null) as key}
      {@const value = data[key]}
      <div class="grid grid-cols-1 gap-1 py-3 compact:py-1.5 sm:grid-cols-3 sm:gap-4 compact:sm:gap-2">
        <dt class="font-medium text-gray-900 dark:text-white">{key}</dt>
        {#if value instanceof URL}
          <dd class="text-gray-700 sm:col-span-2 dark:text-gray-200">
            <a target="_blank" href={value.toString()}>{value}</a>
          </dd>
        {:else if value && typeof value === "object" && "marked" in value}
          <dd class="text-gray-700 sm:col-span-2 dark:text-gray-200">
            <Marked message={value.marked} />
          </dd>
        {:else}
          <dd class="text-gray-700 sm:col-span-2 dark:text-gray-200">{value}</dd>
        {/if}
      </div>
    {/each}
  </dl>
</div>
