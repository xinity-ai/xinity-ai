<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    deploymentName = "Deployment",
    publicSpecifier = "",
    creatorName = "",
    orgName = "",
    dashboardUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<EmailLayout
  title="New Deployment Created"
  preview="A new deployment &quot;{deploymentName}&quot; was created in {orgName}"
  {appName}
  {preferencesUrl}
>
  <EmailText style="font-size:20px;font-weight:bold">New Deployment Created</EmailText>
  <EmailText>
    <strong>{creatorName}</strong> created a new deployment in <strong>{orgName}</strong>.
  </EmailText>
  <EmailText>
    Name: <strong>{deploymentName}</strong><br />
    Model: <strong>{publicSpecifier}</strong>
  </EmailText>
  <EmailText>The deployment is now being installed on available nodes.</EmailText>
  <EmailButton href={dashboardUrl}>View Deployment</EmailButton>
</EmailLayout>
