<script>
  const { appName = "Xinity", supportEmail = "support@xinity.ai", preferencesUrl = "" } = $props();
</script>

<mj-section background-color="#f4f4f4" padding="20px">
  <mj-column>
    <mj-text align="center" font-size="12px" color="#999999">
      You are receiving this email because you're a registered user of {appName}.
      <br />
      Need help?
      <a href="mailto:{supportEmail}" style="color:#999999;">Contact Support</a>
      {#if preferencesUrl}
        &nbsp;|&nbsp;
        <a href={preferencesUrl} style="color:#999999;">Manage notification preferences</a>
      {/if}
    </mj-text>
  </mj-column>
</mj-section>
