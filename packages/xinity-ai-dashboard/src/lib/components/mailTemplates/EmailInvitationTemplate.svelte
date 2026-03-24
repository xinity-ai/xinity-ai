<script lang="ts">
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  export let url: string;
  export let inviterName: string;
  export let orgName: string;
  export let loginUrl: string;

  let appName = "Xinity";
</script>

<mjml>
  <mj-head>
    <mj-title>You’ve Been Invited to {orgName}</mj-title>
    <mj-preview>Join your team on {orgName}</mj-preview>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold">You’re Invited!</mj-text>
        <mj-text>
          <strong>{inviterName}</strong> has invited you to join the
          <strong>{orgName}</strong> on {appName}.
        </mj-text>

        <mj-text padding="20px 0 0 0" font-weight="bold">Important:</mj-text>
        <mj-text>
          Before accepting this invitation, please ensure you have:
          <ol>
            <li>Created an account with this email address.</li>
            <li>Verified your email address.</li>
          </ol>
          Once you have done this, you can click the button below to accept the invitation.
        </mj-text>
        <mj-text>
          <a href={loginUrl}>Create an account or Log in here</a>
        </mj-text>

        <mj-button href={url} background-color="#6f42c1"
          >Accept Invitation</mj-button
        >

        <mj-text font-size="14px" color="#999999">
          If you need access to the organization via a different email, please
          contact the organization owner.
        </mj-text>
        <mj-text font-size="14px" color="#999999">
          Don’t recognize this? You can safely ignore this email.
        </mj-text>
      </mj-column>
    </mj-section>

    <EmailFooter />
  </mj-body>
</mjml>
