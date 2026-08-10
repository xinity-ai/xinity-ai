<script lang="ts">
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Label } from "$lib/components/ui/label";
  import { ExternalLink, ScrollText } from "@lucide/svelte";
  import type { ModelLicense } from "xinity-infoserver";

  let {
    licenses,
    consented = $bindable(false),
    idSuffix = "",
  }: {
    licenses: ModelLicense[];
    consented: boolean;
    idSuffix?: string;
  } = $props();

  const forbidsCommercialUse = $derived(
    licenses.some(license => license.use === "non-commercial" || license.use === "unknown"),
  );

  const palette = $derived(
    forbidsCommercialUse
      ? {
          container: "border-red-500/30 bg-red-500/10",
          icon: "text-red-600 dark:text-red-400",
          heading: "text-red-700 dark:text-red-300",
          body: "text-red-600 dark:text-red-400",
        }
      : {
          container: "border-amber-500/30 bg-amber-500/10",
          icon: "text-amber-600 dark:text-amber-400",
          heading: "text-amber-700 dark:text-amber-300",
          body: "text-amber-600 dark:text-amber-400",
        },
  );
</script>

<div class="flex items-start gap-3 rounded-lg border p-4 {palette.container}">
  <ScrollText class="w-5 h-5 shrink-0 mt-0.5 {palette.icon}" />
  <div class="space-y-3 min-w-0">
    <p class="font-medium {palette.heading}">
      {forbidsCommercialUse ? "Restricted license" : "License conditions apply"}
    </p>

    {#each licenses as license (license.name)}
      <div class="text-sm {palette.body}">
        <p class="font-medium">
          {license.use === "unknown" ? "License terms unknown" : license.name}
        </p>
        {#if license.summary}
          <p class="mt-0.5">{license.summary}</p>
        {/if}
        <a
          href={license.url}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 mt-1 underline underline-offset-2 hover:no-underline"
        >
          Read the license
          <ExternalLink class="w-3 h-3" />
        </a>
      </div>
    {/each}

    <div class="flex items-center gap-2">
      <Checkbox id="license-consent{idSuffix}" bind:checked={consented} />
      <Label for="license-consent{idSuffix}" class="text-sm cursor-pointer {palette.heading}">
        I have read the license and accept responsibility for using this model within its terms
      </Label>
    </div>
  </div>
</div>
