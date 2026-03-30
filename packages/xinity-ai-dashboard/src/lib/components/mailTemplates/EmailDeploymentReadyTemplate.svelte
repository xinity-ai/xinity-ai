<script>
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  const {
    deploymentName = "Deployment",
    modelSpecifier = "",
    orgName = "",
    dashboardUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<mjml>
  <mj-head>
    <mj-title>Deployment Ready</mj-title>
    <mj-preview>Your deployment "{deploymentName}" is ready</mj-preview>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold" color="#16a34a">Deployment Ready</mj-text>
        <mj-text>
          Your deployment <strong>{deploymentName}</strong> in <strong>{orgName}</strong> is now fully operational.
        </mj-text>
        <mj-text>
          Model: <strong>{modelSpecifier}</strong>
        </mj-text>
        <mj-text>
          All requested replicas have been installed and are ready to serve requests.
        </mj-text>
        <mj-button href={dashboardUrl} background-color="#16a34a">View Deployment</mj-button>
      </mj-column>
    </mj-section>

    <EmailFooter {appName} {preferencesUrl} />
  </mj-body>
</mjml>
