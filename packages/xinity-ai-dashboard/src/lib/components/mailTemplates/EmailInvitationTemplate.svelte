<script>
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    url = "",
    inviterName = "",
    orgName = "",
    loginUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
  } = $props();
</script>

<EmailLayout
  title="You’ve Been Invited to {orgName}"
  preview="Join your team on {orgName}"
  {appName}
  {preferencesUrl}
>
  <EmailText style="font-size:20px;font-weight:bold">You’re Invited!</EmailText>
  <EmailText>
    <strong>{inviterName}</strong> has invited you to join the
    <strong>{orgName}</strong> on {appName}.
  </EmailText>

  <EmailText style="padding-top:20px;font-weight:bold">Important:</EmailText>
  <EmailText>
    Before accepting this invitation, please ensure you have:
    <ol>
      <li>Created an account with this email address.</li>
      <li>Verified your email address.</li>
    </ol>
    Once you have done this, you can click the button below to accept the invitation.
  </EmailText>
  <EmailText>
    <a href={loginUrl}>Create an account or Log in here</a>
  </EmailText>

  <EmailButton href={url} color="#6f42c1">Accept Invitation</EmailButton>

  <EmailText style="font-size:14px;color:#999999">
    If you need access to the organization via a different email, please contact the organization
    owner.
  </EmailText>
  <EmailText style="font-size:14px;color:#999999">
    Don’t recognize this? You can safely ignore this email.
  </EmailText>
</EmailLayout>
