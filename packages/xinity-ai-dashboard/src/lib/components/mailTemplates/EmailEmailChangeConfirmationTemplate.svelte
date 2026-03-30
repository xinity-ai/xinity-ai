<script>
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  const {
    url = "",
    newEmail = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<mjml>
  <mj-head>
    <mj-title>Confirm Your New Email</mj-title>
    <mj-preview>Security check: confirm your new email</mj-preview>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold"
          >Confirm Your Email Change</mj-text
        >
        <mj-text
          >You requested to change your email address to <strong
            >{newEmail}</strong
          >. Please confirm to complete the update.</mj-text
        >
        <mj-button href={url} background-color="#17a2b8"
          >Confirm Email</mj-button
        >
        <mj-text font-size="14px" color="#999999"
          >If you didn't request this, you can ignore this email.</mj-text
        >
      </mj-column>
    </mj-section>

    <EmailFooter {appName} {preferencesUrl} />
  </mj-body>
</mjml>
