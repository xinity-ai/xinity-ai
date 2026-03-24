<script lang="ts">
  import { Building } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
</script>

<div class="flex flex-col items-center justify-center h-[60vh] gap-4">
  <Building class="w-12 h-12 text-muted-foreground" />
  <h2 class="text-xl font-semibold">No organization yet</h2>
  <p class="text-muted-foreground text-center max-w-md">
    You need to be part of an organization to access this page. Create one to get started.
  </p>
  <Button href="/organizations">Go to Organizations</Button>
</div>
