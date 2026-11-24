<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    deploymentName = "Deployment",
    publicSpecifier = "",
    notServing = [],
    orgName = "",
    dashboardUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<EmailLayout
  title="Deployment Degraded"
  preview="Deployment &quot;{deploymentName}&quot; is not running as configured"
  {appName}
  {preferencesUrl}
>
  <EmailText style="font-size:20px;font-weight:bold;color:#d97706">Deployment Degraded</EmailText>
  <EmailText>
    The deployment <strong>{deploymentName}</strong> in <strong>{orgName}</strong> still answers requests, but not as configured.
  </EmailText>
  <EmailText>
    Model: <strong>{publicSpecifier}</strong>
  </EmailText>
  {#if notServing.length > 0}
    <EmailText>
      No replica of <strong>{notServing.join(", ")}</strong> is serving, so all traffic goes to the other model of the rollout,
      whatever the split says. The rollout cannot be promoted until it serves.
    </EmailText>
  {/if}
  <EmailText>
    The deployment's page shows which replicas failed or found no machine.
  </EmailText>
  <EmailButton href={dashboardUrl} color="#d97706">View Deployment</EmailButton>
</EmailLayout>
