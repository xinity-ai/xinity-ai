<script lang="ts">
  import type { Snippet } from "svelte";
  import { twMerge } from "tailwind-merge";

  let { class: className = "", children }: { class?: string; children: Snippet } = $props();
</script>

<div class={twMerge("bg-card rounded-xl border shadow-2xl max-w-md w-full p-6", className)}>
  {@render children()}
</div>
