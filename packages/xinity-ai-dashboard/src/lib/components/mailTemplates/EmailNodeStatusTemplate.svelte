<script>
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  const {
    nodeHost = "",
    status = "offline",
    dashboardUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();

  // svelte-ignore state_referenced_locally
  const isOnline = status === "online";
</script>

<mjml>
  <mj-head>
    <mj-title>Node {status === "online" ? "Online" : "Offline"}</mj-title>
    <mj-preview>AI node {nodeHost} is now {status}</mj-preview>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold" color={isOnline ? "#16a34a" : "#dc2626"}>
          Node {isOnline ? "Online" : "Offline"}
        </mj-text>
        <mj-text>
          The inference node <strong>{nodeHost}</strong> has gone <strong>{status}</strong>.
        </mj-text>
        {#if !isOnline}
          <mj-text>
            Deployments hosted on this node may be affected. The orchestration service will attempt
            to redistribute workloads to available nodes.
          </mj-text>
        {:else}
          <mj-text>
            The node is back online and available for workloads.
          </mj-text>
        {/if}
        <mj-button href={dashboardUrl} background-color={isOnline ? "#16a34a" : "#dc2626"}>View Infrastructure</mj-button>
      </mj-column>
    </mj-section>

    <EmailFooter {appName} {preferencesUrl} />
  </mj-body>
</mjml>
