<script lang="ts">
  import type { DeploymentOf } from "../+page.server";
  import ModelFacts from "../ModelFacts.svelte";

  let { deployment }: { deployment: DeploymentOf<"managed"> } = $props();
</script>

<ModelFacts model={deployment.managed} />
