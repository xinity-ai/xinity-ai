<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import type { ModelLicense } from "xinity-infoserver";

  let { license, class: className = "" }: { license: ModelLicense; class?: string } = $props();

  const tone = $derived(
    license.use === "open"
      ? "border-border text-muted-foreground"
      : license.use === "conditional"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  );

  const label = $derived(license.use === "unknown" ? "License unknown" : license.name);
</script>

<Badge variant="outline" class="{tone} {className}" title={license.summary ?? license.name}>
  {label}
</Badge>
