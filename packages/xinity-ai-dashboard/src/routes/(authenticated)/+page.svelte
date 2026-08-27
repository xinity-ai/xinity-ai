<script lang="ts">
  import Dashboard from "./Dashboard.svelte";
  import OnboardingFlow from "./OnboardingFlow.svelte";
  import GettingStartedChecklist from "./GettingStartedChecklist.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  // Onboarding activates the organization and reloads, and its success card
  // holds the only copy of the new API key, so it stays mounted after noOrg
  // turns false.
  let onboarded = $state(false);
</script>

<svelte:head>
  <title>Xinity Dashboard</title>
</svelte:head>

{#if data.noOrg || onboarded}
  <OnboardingFlow onCompleted={() => (onboarded = true)} />
{/if}

{#if !data.displaySettings?.gettingStartedDismissed}
  <GettingStartedChecklist
    checklist={data.checklist}
    displaySettings={data.displaySettings}
  />
{/if}

{#if !data.noOrg && !onboarded}
  <Dashboard
    keyMetrics={data.keyMetrics}
    charts={data.charts}
    tables={data.tables}
  />
{/if}
