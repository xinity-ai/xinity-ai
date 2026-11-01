<script lang="ts">
  import type { Snippet } from "svelte";

  const { width, children }: { width: string; children: Snippet } = $props();
</script>

<td class="email-column" {width} valign="top" style="width:{width}">
  {@render children()}
</td>
