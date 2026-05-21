<script lang="ts">
  import type { Snippet } from "svelte";
  import ToastContainer from "$lib/components/ToastContainer.svelte";
  import VersionNotice from "$lib/components/VersionNotice.svelte";
  import LicenseBanner from "$lib/components/LicenseBanner.svelte";
  import Sidebar from "./Sidebar.svelte";
  import { permissions } from "$lib/state/permissions.svelte";
  import type { LayoutServerData } from "./$types";

  let { data, children }: { data: LayoutServerData; children: Snippet } = $props();

  $effect(()=> { document.body.classList.toggle("compact", data.displaySettings.compactView); });
  $effect(()=> { permissions.setRole(data.memberRole); });
</script>

<Sidebar isInstanceAdmin={data.isInstanceAdmin} license={data.license} />
<main class="sm:ml-64 ml-14 min-w-0">
  <VersionNotice versioning={data.versioning} />
  <LicenseBanner license={data.license} totalVramGb={data.totalVramGb} />
  {@render children()}
</main>

<ToastContainer />
