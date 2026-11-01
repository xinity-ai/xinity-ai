<script lang="ts">
  import type { Snippet } from "svelte";

  const { children }: { children: Snippet } = $props();
</script>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tbody>
    <tr>
      {@render children()}
    </tr>
  </tbody>
</table>
