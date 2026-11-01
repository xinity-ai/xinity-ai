<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    nodeHost = "",
    status = "offline",
    dashboardUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();

  // svelte-ignore state_referenced_locally
  const isOnline = status === "online";
  const statusColor = isOnline ? "#16a34a" : "#dc2626";
  const title = `Node ${isOnline ? "Online" : "Offline"}`;
</script>

<EmailLayout {title} preview="AI node {nodeHost} is now {status}" {appName} {preferencesUrl}>
  <EmailText style="font-size:20px;font-weight:bold;color:{statusColor}">{title}</EmailText>
  <EmailText>
    The inference node <strong>{nodeHost}</strong> has gone <strong>{status}</strong>.
  </EmailText>
  {#if !isOnline}
    <EmailText>
      Deployments hosted on this node may be affected. The orchestration service will attempt
      to redistribute workloads to available nodes.
    </EmailText>
  {:else}
    <EmailText>The node is back online and available for workloads.</EmailText>
  {/if}
  <EmailButton href={dashboardUrl} color={statusColor}>View Infrastructure</EmailButton>
</EmailLayout>
