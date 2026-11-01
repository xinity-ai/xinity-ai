<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    url = "",
    newEmail = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<EmailLayout
  title="Confirm Your New Email"
  preview="Security check: confirm your new email"
  {appName}
  {preferencesUrl}
>
  <EmailText style="font-size:20px;font-weight:bold">Confirm Your Email Change</EmailText>
  <EmailText>
    You requested to change your email address to <strong>{newEmail}</strong>. Please confirm to
    complete the update.
  </EmailText>
  <EmailButton href={url} color="#17a2b8">Confirm Email</EmailButton>
  <EmailText style="font-size:14px;color:#999999">
    If you didn't request this, you can ignore this email.
  </EmailText>
</EmailLayout>
