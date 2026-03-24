<script lang="ts">
  import DataPageLayout from "../[applicationId=uuid]/DataPageLayout.svelte";
</script>

<svelte:head>
  <title>Data - Uncategorized</title>
</svelte:head>

<DataPageLayout
  applicationId={null}
  title="Uncategorized Data"
  description="Calls without an application assignment. Use the X-Application header to route calls to specific applications."
/>
