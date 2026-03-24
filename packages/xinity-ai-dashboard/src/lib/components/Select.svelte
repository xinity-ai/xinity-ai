<script lang="ts">
  export let name: string;
  export let value: string | undefined;
</script>

<div
  class="flex items-center w-full text-gray-700 bg-white border border-gray-400 rounded sm:text-sm"
>
  <select
    on:change
    bind:value
    {name}
    id={name}
    class="flex-1 p-2 bg-white rounded appearance-none outline-none {$$props.class}"
  >
    <slot />
  </select>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    stroke-width="1.5"
    stroke="currentColor"
    class="size-6"
  >
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      d="m19.5 8.25-7.5 7.5-7.5-7.5"
    />
  </svg>
</div>
