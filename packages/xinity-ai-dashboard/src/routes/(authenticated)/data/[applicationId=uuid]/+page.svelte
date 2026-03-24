<script lang="ts">
  import { page } from "$app/stores";
  import type { PageData } from "./$types";
  import DataPageLayout from "./DataPageLayout.svelte";
  import NoOrganization from "$lib/components/NoOrganization.svelte";

  let { data }: { data: PageData } = $props();

  const application = $derived(data.application);
  const applicationId = $page.params.applicationId!;
</script>

<svelte:head>
  <title>{application ? `Data - ${application.name}` : "Data"}</title>
</svelte:head>

{#if !application}
  <NoOrganization />
{:else}
  <DataPageLayout
    {applicationId}
    title="{application.name} Data"
    description="View, analyze, and improve your application data."
  />
{/if}
