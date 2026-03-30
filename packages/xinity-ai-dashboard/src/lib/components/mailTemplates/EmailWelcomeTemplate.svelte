<script>
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  const {
    userName = "",
    appName = "Xinity",
    appUrl = "https://xinity.ai",
    preferencesUrl = "",
  } = $props();

  const greeting = $derived(userName ? `Welcome, ${userName}!` : `Welcome to ${appName}!`);
</script>

<mjml>
  <mj-head>
    <mj-title>Welcome to {appName}</mj-title>
    <mj-preview>Get started with your new account</mj-preview>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader></EmailHeader>
    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold"
          >{greeting}</mj-text
        >
        <mj-text
          >We're excited to have you on board. Start exploring your dashboard or
          set up your profile.</mj-text
        >
        <mj-button href={appUrl + "/start"} background-color="#007BFF"
          >Get Started</mj-button
        >
      </mj-column>
    </mj-section>

    <EmailFooter {appName} {preferencesUrl}></EmailFooter>
  </mj-body>
</mjml>
