<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    usedPercent = 0,
    totalCapacityGb = 0,
    usedCapacityGb = 0,
    dashboardUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<EmailLayout
  title="Capacity Warning"
  preview="Cluster capacity at {usedPercent}%"
  {appName}
  {preferencesUrl}
>
  <EmailText style="font-size:20px;font-weight:bold;color:#ea580c">Capacity Warning</EmailText>
  <EmailText>
    Your cluster GPU capacity has reached <strong>{usedPercent}%</strong> utilization.
  </EmailText>
  <EmailText>
    Used: <strong>{usedCapacityGb} GB</strong> / Total: <strong>{totalCapacityGb} GB</strong>
  </EmailText>
  <EmailText>
    Consider adding more inference nodes or reducing active deployments to ensure reliable service.
  </EmailText>
  <EmailButton href={dashboardUrl} color="#ea580c">View Infrastructure</EmailButton>
</EmailLayout>
