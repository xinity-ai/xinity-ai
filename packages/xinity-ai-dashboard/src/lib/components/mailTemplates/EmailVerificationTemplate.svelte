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
  title="Verify Your Account"
  preview="Confirm your email to activate your account"
  {appName}
  {preferencesUrl}
>
  <EmailImage
    src="https://placeholder.pics/svg/80x80/28a745/ffffff/Check"
    alt="Verification Icon"
    width={80}
  />
  <EmailText style="font-size:20px;font-weight:bold">Verify Your Email Address</EmailText>
  <EmailText>
    Thanks for signing up! Please confirm your email address by clicking the button below. This
    helps us keep your account secure.
  </EmailText>
  <EmailButton href={url} color="#28a745">Verify My Account</EmailButton>
  <EmailText style="font-size:14px;color:#999999">
    If you did not create this account, you can safely ignore this email.
  </EmailText>
</EmailLayout>
