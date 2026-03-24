<script lang="ts">
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  export let url: string;
</script>

<mjml>
  <mj-head>
    <mj-title>Reset Your Password</mj-title>
    <mj-preview>Instructions to reset your password</mj-preview>
    <mj-attributes>
      <mj-all font-family="Helvetica, Arial, sans-serif"></mj-all>
      <mj-text font-size="16px" color="#333333"></mj-text>
      <mj-button
        background-color="#dc3545"
        color="#ffffff"
        font-size="16px"
        border-radius="5px"
        padding="20px"
      ></mj-button>
    </mj-attributes>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <!-- Reset Password Content -->
    <mj-section background-color="#ffffff" padding="20px">
      <mj-column width="100%">
        <mj-image
          width="80px"
          src="https://placeholder.pics/svg/80x80/dc3545/ffffff/Key"
          alt="Reset Icon"
          padding="10px 0"
        ></mj-image>
        <mj-text font-size="20px" font-weight="bold" padding="10px 0"
          >Reset Your Password</mj-text
        >
        <mj-text padding="10px 0">
          We received a request to reset your password. Click the button below
          to choose a new one. If you didn’t request this, you can safely ignore
          this email.
        </mj-text>
        <mj-button href={url}> Reset My Password </mj-button>
        <mj-text font-size="14px" color="#999999" padding="20px 0 0 0">
          For security reasons, this link will expire in 1 hour.
        </mj-text>
      </mj-column>
    </mj-section>

    <EmailFooter />
  </mj-body>
</mjml>
