<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    deploymentName = "Deployment",
    publicSpecifier = "",
    errorMessage = "An unknown error occurred",
    orgName = "",
    dashboardUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<EmailLayout
  title="Deployment Failed"
  preview="Deployment &quot;{deploymentName}&quot; has encountered an error"
  {appName}
  {preferencesUrl}
>
  <EmailText style="font-size:20px;font-weight:bold;color:#dc2626">Deployment Failed</EmailText>
  <EmailText>
    The deployment <strong>{deploymentName}</strong> in <strong>{orgName}</strong> has failed.
  </EmailText>
  <EmailText>
    Model: <strong>{publicSpecifier}</strong>
  </EmailText>
  <EmailText style="font-weight:bold">Error Details:</EmailText>
  <EmailText background="#fef2f2" style="font-family:monospace;font-size:14px">{errorMessage}</EmailText>
  <EmailText>
    Please check the deployment configuration and try again, or contact your administrator.
  </EmailText>
  <EmailButton href={dashboardUrl} color="#dc2626">View Deployment</EmailButton>
</EmailLayout>
