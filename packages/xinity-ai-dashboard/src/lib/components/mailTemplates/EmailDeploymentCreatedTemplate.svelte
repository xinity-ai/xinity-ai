<script>
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  const {
    deploymentName = "Deployment",
    modelSpecifier = "",
    creatorName = "",
    orgName = "",
    dashboardUrl = "",
  } = $props();
</script>

<mjml>
  <mj-head>
    <mj-title>New Deployment Created</mj-title>
    <mj-preview>A new deployment "{deploymentName}" was created in {orgName}</mj-preview>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold">New Deployment Created</mj-text>
        <mj-text>
          <strong>{creatorName}</strong> created a new deployment in <strong>{orgName}</strong>.
        </mj-text>
        <mj-text>
          Name: <strong>{deploymentName}</strong><br />
          Model: <strong>{modelSpecifier}</strong>
        </mj-text>
        <mj-text>
          The deployment is now being installed on available nodes.
        </mj-text>
        <mj-button href={dashboardUrl} background-color="#007BFF">View Deployment</mj-button>
      </mj-column>
    </mj-section>

    <EmailFooter />
  </mj-body>
</mjml>
