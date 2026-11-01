<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailImage from "./partials/EmailImage.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    url = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<EmailLayout
  title="Reset Your Password"
  preview="Instructions to reset your password"
  {appName}
  {preferencesUrl}
>
  <EmailImage src="https://placeholder.pics/svg/80x80/dc3545/ffffff/Key" alt="Reset Icon" width={80} />
  <EmailText style="font-size:20px;font-weight:bold">Reset Your Password</EmailText>
  <EmailText>
    We received a request to reset your password. Click the button below to choose a new one. If
    you didn’t request this, you can safely ignore this email.
  </EmailText>
  <EmailButton href={url} color="#dc3545">Reset My Password</EmailButton>
  <EmailText style="font-size:14px;color:#999999">
    For security reasons, this link will expire in 1 hour.
  </EmailText>
</EmailLayout>
