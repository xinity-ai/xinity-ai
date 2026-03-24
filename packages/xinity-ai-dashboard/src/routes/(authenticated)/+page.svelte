<script>
  import Dashboard from "./Dashboard.svelte";
  import OnboardingFlow from "./OnboardingFlow.svelte";
  import GettingStartedChecklist from "./GettingStartedChecklist.svelte";

  export let data;

  // Extract only dashboard data, excluding user
  const {
    noOrg,
    checklist,
    apiCallStats,
    tokenStats,
    recentModels,
    topApplications,
    responseRatings,
    trainingData,
    recentActivities,
    usageTrend,
  } = data;
</script>

<svelte:head>
  <title>Xinity Dashboard</title>
</svelte:head>

{#if noOrg}
  <OnboardingFlow />
{/if}

{#if !data.displaySettings?.gettingStartedDismissed}
  <GettingStartedChecklist
    {checklist}
    displaySettings={data.displaySettings}
  />
{/if}

{#if !noOrg}
  <Dashboard
    {apiCallStats}
    {tokenStats}
    {recentModels}
    {topApplications}
    {responseRatings}
    {trainingData}
    {recentActivities}
    {usageTrend}
  />
{/if}
