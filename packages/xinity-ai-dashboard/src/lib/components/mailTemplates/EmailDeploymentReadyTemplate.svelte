<script>
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  const {
    deploymentName = "Deployment",
    publicSpecifier = "",
    orgName = "",
    dashboardUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
    observedReplicas = 0,
    desiredReplicas = 0,
  } = $props();

  // Defaults of 0 keep the unqualified wording for any notification queued without the counts.
  const isUnderProvisioned = $derived(observedReplicas < desiredReplicas);
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
          Your deployment <strong>{deploymentName}</strong> in <strong>{orgName}</strong> is now serving requests.
        </mj-text>
        <mj-text>
          Model: <strong>{publicSpecifier}</strong>
        </mj-text>
        {#if isUnderProvisioned}
          <mj-text>
            {observedReplicas} of {desiredReplicas} requested replicas are installed and ready to serve
            requests. The remaining {desiredReplicas - observedReplicas} could not be placed, usually
            because no node has enough free VRAM or the required driver.
          </mj-text>
        {:else}
          <mj-text>
            All requested replicas have been installed and are ready to serve requests.
          </mj-text>
        {/if}
        <mj-button href={dashboardUrl} background-color="#16a34a">View Deployment</mj-button>
      </mj-column>
    </mj-section>

    <EmailFooter {appName} {preferencesUrl} />
  </mj-body>
</mjml>
