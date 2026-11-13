<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    deploymentName = "Deployment",
    publicSpecifier = "",
    orgName = "",
    dashboardUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<EmailLayout
  title="Deployment Down"
  preview="Deployment &quot;{deploymentName}&quot; no longer answers requests"
  {appName}
  {preferencesUrl}
>
  <EmailText style="font-size:20px;font-weight:bold;color:#dc2626">Deployment Down</EmailText>
  <EmailText>
    The deployment <strong>{deploymentName}</strong> in <strong>{orgName}</strong> is down. Requests to it fail.
  </EmailText>
  <EmailText>
    Model: <strong>{publicSpecifier}</strong>
  </EmailText>
  <EmailText>
    The machines its replicas ran on went offline, and no other machine can take them.
  </EmailText>
  <EmailButton href={dashboardUrl} color="#dc2626">View Deployment</EmailButton>
</EmailLayout>
