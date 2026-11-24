<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";

  let { class: className = "" }: { class?: string } = $props();
</script>

<Badge
  variant="outline"
  class="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 {className}"
>
  New
</Badge>
