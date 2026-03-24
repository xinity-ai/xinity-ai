<script>
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  const {
    orgName = "",
    deploymentCount = 0,
    activeNodes = 0,
    totalApiCalls = 0,
    topModels = [],
    period = "",
    dashboardUrl = "",
  } = $props();
</script>

<mjml>
  <mj-head>
    <mj-title>Weekly Report - {orgName}</mj-title>
    <mj-preview>Your weekly summary for {orgName}</mj-preview>
    <mj-attributes>
      <mj-all font-family="Helvetica, Arial, sans-serif"></mj-all>
    </mj-attributes>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold">Weekly Report</mj-text>
        <mj-text font-size="14px" color="#666666">{period}, {orgName}</mj-text>
      </mj-column>
    </mj-section>

    <mj-section background-color="#ffffff" padding="0 20px">
      <mj-column>
        <mj-text font-weight="bold" font-size="16px" padding="10px 0 5px 0">Overview</mj-text>
      </mj-column>
    </mj-section>

    <mj-section background-color="#ffffff" padding="0 20px">
      <mj-column width="33%">
        <mj-text align="center" font-size="28px" font-weight="bold" color="#007BFF">{deploymentCount}</mj-text>
        <mj-text align="center" font-size="12px" color="#666666">Active Deployments</mj-text>
      </mj-column>
      <mj-column width="33%">
        <mj-text align="center" font-size="28px" font-weight="bold" color="#16a34a">{activeNodes}</mj-text>
        <mj-text align="center" font-size="12px" color="#666666">Online Nodes</mj-text>
      </mj-column>
      <mj-column width="33%">
        <mj-text align="center" font-size="28px" font-weight="bold" color="#8b5cf6">{totalApiCalls}</mj-text>
        <mj-text align="center" font-size="12px" color="#666666">API Calls</mj-text>
      </mj-column>
    </mj-section>

    {#if topModels.length > 0}
      <mj-section background-color="#ffffff" padding="10px 20px 0 20px">
        <mj-column>
          <mj-text font-weight="bold" font-size="16px" padding="10px 0 5px 0">Top Models</mj-text>
          {#each topModels as model}
            <mj-text font-size="14px" padding="2px 0">
              &bull; {model.name}: {model.calls} calls
            </mj-text>
          {/each}
        </mj-column>
      </mj-section>
    {/if}

    <mj-section background-color="#ffffff" padding="10px 20px 20px 20px">
      <mj-column>
        <mj-button href={dashboardUrl} background-color="#007BFF">Open Dashboard</mj-button>
      </mj-column>
    </mj-section>

    <EmailFooter />
  </mj-body>
</mjml>
