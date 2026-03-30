<script>
  import EmailHeader from "./partials/EmailHeader.svelte";
  import EmailFooter from "./partials/EmailFooter.svelte";

  const {
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>
<mjml>
  <mj-head>
    <mj-title>Security Alert: Account Deactivation</mj-title>
    <mj-preview>We’ve deactivated your account or noticed suspicious activity</mj-preview>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold">Your Account Has Been Deactivated</mj-text>
        <mj-text>We detected unusual activity and temporarily deactivated your account to protect your data.</mj-text>
        <mj-button href="https://yourapp.com/reactivate" background-color="#dc3545">Reactivate Account</mj-button>
        <mj-text font-size="14px" color="#999999">If this was unexpected, please contact support immediately.</mj-text>
      </mj-column>
    </mj-section>

    <EmailFooter {appName} {preferencesUrl} />
  </mj-body>
</mjml>
