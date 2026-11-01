<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

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

<EmailLayout
  title="Deployment Ready"
  preview="Your deployment &quot;{deploymentName}&quot; is ready"
  {appName}
  {preferencesUrl}
>
  <EmailText style="font-size:20px;font-weight:bold;color:#16a34a">Deployment Ready</EmailText>
  <EmailText>
    Your deployment <strong>{deploymentName}</strong> in <strong>{orgName}</strong> is now serving requests.
  </EmailText>
  <EmailText>
    Model: <strong>{publicSpecifier}</strong>
  </EmailText>
  {#if isUnderProvisioned}
    <EmailText>
      {observedReplicas} of {desiredReplicas} requested replicas are installed and ready to serve
      requests. The remaining {desiredReplicas - observedReplicas} could not be placed, usually
      because no node has enough free VRAM or the required driver.
    </EmailText>
  {:else}
    <EmailText>All requested replicas have been installed and are ready to serve requests.</EmailText>
  {/if}
  <EmailButton href={dashboardUrl} color="#16a34a">View Deployment</EmailButton>
</EmailLayout>
