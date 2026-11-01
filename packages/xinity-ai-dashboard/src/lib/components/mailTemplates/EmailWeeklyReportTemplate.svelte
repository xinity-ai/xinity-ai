<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailColumn from "./partials/EmailColumn.svelte";
  import EmailColumns from "./partials/EmailColumns.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    orgName = "",
    deploymentCount = 0,
    activeNodes = 0,
    totalApiCalls = 0,
    topModels = [],
    period = "",
    dashboardUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();

  const stats = $derived([
    { value: deploymentCount, label: "Active Deployments", color: "#007BFF" },
    { value: activeNodes, label: "Online Nodes", color: "#16a34a" },
    { value: totalApiCalls, label: "API Calls", color: "#8b5cf6" },
  ]);
</script>

<EmailLayout
  title="Weekly Report - {orgName}"
  preview="Your weekly summary for {orgName}"
  {appName}
  {preferencesUrl}
>
  <EmailText style="font-size:20px;font-weight:bold">Weekly Report</EmailText>
  <EmailText style="font-size:14px;color:#666666">{[period, orgName].filter(Boolean).join(", ")}</EmailText>

  <EmailText style="padding-top:20px;font-weight:bold">Overview</EmailText>
  <EmailColumns>
    {#each stats as stat (stat.label)}
      <EmailColumn width="33%">
        <EmailText style="padding-bottom:0;text-align:center;font-size:28px;font-weight:bold;color:{stat.color}">
          {stat.value}
        </EmailText>
        <EmailText style="padding-top:0;text-align:center;font-size:12px;color:#666666">{stat.label}</EmailText>
      </EmailColumn>
    {/each}
  </EmailColumns>

  {#if topModels.length > 0}
    <EmailText style="padding-top:20px;font-weight:bold">Top Models</EmailText>
    {#each topModels as model}
      <EmailText style="padding-top:2px;padding-bottom:2px;font-size:14px">
        &bull; {model.name}: {model.calls} calls
      </EmailText>
    {/each}
  {/if}

  <EmailButton href={dashboardUrl}>Open Dashboard</EmailButton>
</EmailLayout>
