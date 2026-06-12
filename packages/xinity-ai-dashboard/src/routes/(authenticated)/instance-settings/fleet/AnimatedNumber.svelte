<script lang="ts">
  import { Tween } from "svelte/motion";
  import { cubicOut } from "svelte/easing";

  let { value, format = (v: number) => String(Math.round(v)) }: {
    value: number;
    format?: (v: number) => string;
  } = $props();

  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // svelte-ignore state_referenced_locally -- the tween starts at the initial value on purpose
  const tween = new Tween(value, { duration: reducedMotion ? 0 : 700, easing: cubicOut });

  $effect(() => {
    tween.set(value);
  });
</script>

{format(tween.current)}
