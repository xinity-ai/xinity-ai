<script lang="ts">
  import type { DeploymentDefinition } from "./+page.server";
  import { humanDate, humanDuration } from "$lib/util";
  import { Info } from "@lucide/svelte";

  let { deployment }: { deployment: DeploymentDefinition } = $props();
</script>

{#if deployment.legacy.deprecatedModel}
  <p class="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
    <Info class="w-3.5 h-3.5 shrink-0 mt-0.5" />
    <span>
      Uses a model entry in a format that is being retired. It keeps running for now.
      Edit this deployment and pick a current entry to move it over.
    </span>
  </p>
{/if}

{#if deployment.legacy.canaryProgressUntil}
  <div>
    <p class="text-sm text-muted-foreground mb-2">Traffic Distribution</p>
    <div class="w-full bg-muted rounded-full h-2">
      <div
        class="bg-primary h-2 rounded-full transition-all"
        style="width: {deployment.legacy.progress}%"
      ></div>
    </div>
    <div class="flex flex-wrap mt-1.5 text-xs text-muted-foreground">
      <span>{deployment.legacy.progress}% to {deployment.publicSpecifier}</span>
      {#if deployment.legacy.earlySpecifier && 100 - deployment.legacy.progress > 0}
        <span class="ml-auto">
          {100 - deployment.legacy.progress}% to {deployment.legacy.earlySpecifier}
        </span>
      {/if}
    </div>
  </div>
{/if}

{#if (deployment.legacy.canaryProgressUntil?.valueOf() || 0) >= Date.now()}
  <div>
    <p class="text-sm text-muted-foreground">Deployment Timeline</p>
    <p class="font-medium">
      Complete on {humanDate(deployment.legacy.canaryProgressUntil!)}
    </p>
  </div>

  <div>
    <p class="text-sm text-muted-foreground">Deployment Duration</p>
    <p class="font-medium">
      {(deployment.legacy.canaryProgressUntil &&
        deployment.legacy.canaryProgressFrom &&
        humanDuration(
          (deployment.legacy.canaryProgressUntil.valueOf() -
            deployment.legacy.canaryProgressFrom.valueOf()) /
            1000 /
            60 /
            60,
        )) ||
        "N/A"}
    </p>
  </div>
{/if}
