<script>
  import Dashboard from "./Dashboard.svelte";
  import OnboardingFlow from "./OnboardingFlow.svelte";
  import GettingStartedChecklist from "./GettingStartedChecklist.svelte";

  export let data;
</script>

<svelte:head>
  <title>Xinity Dashboard</title>
</svelte:head>

{#if data.noOrg}
  <OnboardingFlow />
{/if}

{#if !data.displaySettings?.gettingStartedDismissed}
  <GettingStartedChecklist
    checklist={data.checklist}
    displaySettings={data.displaySettings}
  />
{/if}

{#if !data.noOrg}
  <Dashboard
    keyMetrics={data.keyMetrics}
    charts={data.charts}
    tables={data.tables}
  />
{/if}
