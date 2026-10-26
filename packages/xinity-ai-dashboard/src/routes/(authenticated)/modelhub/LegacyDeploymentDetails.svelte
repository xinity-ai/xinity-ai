<script lang="ts">
  import type { DeploymentDefinition } from "./+page.server";
  import { humanDate, humanDuration } from "$lib/util";

  let { deployment }: { deployment: DeploymentDefinition } = $props();
</script>

{#if deployment.canaryProgressUntil}
  <div>
    <p class="text-sm text-muted-foreground mb-2">Traffic Distribution</p>
    <div class="w-full bg-muted rounded-full h-2">
      <div
        class="bg-primary h-2 rounded-full transition-all"
        style="width: {deployment.progress}%"
      ></div>
    </div>
    <div class="flex flex-wrap mt-1.5 text-xs text-muted-foreground">
      <span>{deployment.progress}% to {deployment.publicSpecifier}</span>
      {#if deployment.earlySpecifier && 100 - deployment.progress > 0}
        <span class="ml-auto">
          {100 - deployment.progress}% to {deployment.earlySpecifier}
        </span>
      {/if}
    </div>
  </div>
{/if}

{#if (deployment.canaryProgressUntil?.valueOf() || 0) >= Date.now()}
  <div>
    <p class="text-sm text-muted-foreground">Deployment Timeline</p>
    <p class="font-medium">
      Complete on {humanDate(deployment.canaryProgressUntil!)}
    </p>
  </div>

  <div>
    <p class="text-sm text-muted-foreground">Deployment Duration</p>
    <p class="font-medium">
      {(deployment.canaryProgressUntil &&
        deployment.canaryProgressFrom &&
        humanDuration(
          (deployment.canaryProgressUntil.valueOf() -
            deployment.canaryProgressFrom.valueOf()) /
            1000 /
            60 /
            60,
        )) ||
        "N/A"}
    </p>
  </div>
{/if}
