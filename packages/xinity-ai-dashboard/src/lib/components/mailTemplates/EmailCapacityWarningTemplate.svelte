<script>
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  const {
    usedPercent = 0,
    totalCapacityGb = 0,
    usedCapacityGb = 0,
    dashboardUrl = "",
  } = $props();
</script>

<mjml>
  <mj-head>
    <mj-title>Capacity Warning</mj-title>
    <mj-preview>Cluster capacity at {usedPercent}%</mj-preview>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold" color="#ea580c">Capacity Warning</mj-text>
        <mj-text>
          Your cluster GPU capacity has reached <strong>{usedPercent}%</strong> utilization.
        </mj-text>
        <mj-text>
          Used: <strong>{usedCapacityGb} GB</strong> / Total: <strong>{totalCapacityGb} GB</strong>
        </mj-text>
        <mj-text>
          Consider adding more inference nodes or reducing active deployments to ensure reliable service.
        </mj-text>
        <mj-button href={dashboardUrl} background-color="#ea580c">View Infrastructure</mj-button>
      </mj-column>
    </mj-section>

    <EmailFooter />
  </mj-body>
</mjml>
