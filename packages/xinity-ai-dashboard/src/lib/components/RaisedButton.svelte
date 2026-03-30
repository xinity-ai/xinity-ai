<script lang="ts">
  import { twMerge } from "tailwind-merge";

  export let type: "button" | "submit" | "reset" = "button";
  export let disabled = false;
</script>

<button
  on:click
  on:dblclick
  {disabled}
  {type}
  class={twMerge(
    $$restProps.class,
    "inline-block px-4 py-2 text-xs font-medium text-white bg-xinity-purple rounded hover:bg-xinity-magenta cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200",
  )}
>
  <slot />
</button>
