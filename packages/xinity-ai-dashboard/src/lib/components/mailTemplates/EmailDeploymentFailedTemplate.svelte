<script>
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  const {
    deploymentName = "Deployment",
    modelSpecifier = "",
    errorMessage = "An unknown error occurred",
    orgName = "",
    dashboardUrl = "",
  } = $props();
</script>

<mjml>
  <mj-head>
    <mj-title>Deployment Failed</mj-title>
    <mj-preview>Deployment "{deploymentName}" has encountered an error</mj-preview>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold" color="#dc2626">Deployment Failed</mj-text>
        <mj-text>
          The deployment <strong>{deploymentName}</strong> in <strong>{orgName}</strong> has failed.
        </mj-text>
        <mj-text>
          Model: <strong>{modelSpecifier}</strong>
        </mj-text>
        <mj-text padding="10px 0" font-weight="bold">Error Details:</mj-text>
        <mj-text font-family="monospace" font-size="14px" background-color="#fef2f2" padding="15px" border-radius="5px">
          {errorMessage}
        </mj-text>
        <mj-text padding="10px 0">
          Please check the deployment configuration and try again, or contact your administrator.
        </mj-text>
        <mj-button href={dashboardUrl} background-color="#dc2626">View Deployment</mj-button>
      </mj-column>
    </mj-section>

    <EmailFooter />
  </mj-body>
</mjml>
