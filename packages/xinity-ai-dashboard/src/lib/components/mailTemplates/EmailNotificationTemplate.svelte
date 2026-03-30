<script>
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  const {
    title = "You've got a new notification",
    message = "Hello, you have a new update in your account. Please review the details by clicking the button below.",
    actionUrl = "",
    actionLabel = "View Notification",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<mjml>
  <mj-head>
    <mj-title>{title}</mj-title>
    <mj-preview>{title}</mj-preview>
    <mj-attributes>
      <mj-all font-family="Helvetica, Arial, sans-serif" ></mj-all>
      <mj-text font-size="16px" color="#333333" ></mj-text>
      <mj-button
        background-color="#007BFF"
        color="#ffffff"
        font-size="16px"
        border-radius="5px"
        padding="20px" ></mj-button>
    </mj-attributes>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <mj-section background-color="#ffffff" padding="20px">
      <mj-column width="100%">
        <mj-text font-size="20px" font-weight="bold" padding="10px 0">{title}</mj-text>
        <mj-text padding="10px 0">{message}</mj-text>
        {#if actionUrl}
          <mj-button href={actionUrl}>{actionLabel}</mj-button>
        {/if}
      </mj-column>
    </mj-section>

    <EmailFooter {appName} {preferencesUrl} />
  </mj-body>
</mjml>
