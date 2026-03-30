<script lang="ts">
  import ToastContainer from "$lib/components/ToastContainer.svelte";
  import VersionNotice from "$lib/components/VersionNotice.svelte";
  import LicenseBanner from "$lib/components/LicenseBanner.svelte";
  import Sidebar from "./Sidebar.svelte";
  import { permissions } from "$lib/state/permissions.svelte";
  import type { LayoutServerData } from "./$types";
  import { browser } from "$app/environment";

  export let data: LayoutServerData;

  // Set role from server-loaded data (more reliable than client-side fetch)
  $: permissions.setRole(data.memberRole);
  $: if (browser) document.body.classList.toggle("compact", data.displaySettings.compactView);
</script>

{#if data.license.originMismatch}
  <LicenseBanner license={data.license} totalVramGb={data.totalVramGb} />
{:else}
  <Sidebar isInstanceAdmin={data.isInstanceAdmin} license={data.license} />
  <main class="sm:ml-64 ml-14 min-w-0">
    <VersionNotice versioning={data.versioning} />
    <LicenseBanner license={data.license} totalVramGb={data.totalVramGb} />
    <slot />
  </main>

  <ToastContainer />
{/if}
