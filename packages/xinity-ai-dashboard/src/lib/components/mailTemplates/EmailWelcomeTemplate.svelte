<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    userName = "",
    appName = "Xinity",
    appUrl = "https://xinity.ai",
    preferencesUrl = "",
  } = $props();

  const greeting = $derived(userName ? `Welcome, ${userName}!` : `Welcome to ${appName}!`);
</script>

<EmailLayout
  title="Welcome to {appName}"
  preview="Get started with your new account"
  {appName}
  {preferencesUrl}
>
  <EmailText style="font-size:20px;font-weight:bold">{greeting}</EmailText>
  <EmailText>
    We're excited to have you on board. Start exploring your dashboard or set up your profile.
  </EmailText>
  <EmailButton href={appUrl + "/"}>Get Started</EmailButton>
</EmailLayout>
