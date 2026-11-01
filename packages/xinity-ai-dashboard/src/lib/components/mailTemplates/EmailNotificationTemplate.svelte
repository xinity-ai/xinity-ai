<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    title = "You've got a new notification",
    message = "Hello, you have a new update in your account. Please review the details by clicking the button below.",
    actionUrl = "",
    actionLabel = "View Notification",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<EmailLayout {title} preview={title} {appName} {preferencesUrl}>
  <EmailText style="font-size:20px;font-weight:bold">{title}</EmailText>
  <EmailText>{message}</EmailText>
  {#if actionUrl}
    <EmailButton href={actionUrl}>{actionLabel}</EmailButton>
  {/if}
</EmailLayout>
