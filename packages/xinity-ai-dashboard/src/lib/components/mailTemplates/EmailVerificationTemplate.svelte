<script lang="ts">
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  export let url: string;
</script>

<mjml>
  <mj-head>
    <mj-title>Verify Your Account</mj-title>
    <mj-preview>Confirm your email to activate your account</mj-preview>
    <mj-attributes>
      <mj-all font-family="Helvetica, Arial, sans-serif"></mj-all>
      <mj-text font-size="16px" color="#333333"></mj-text>
      <mj-button
        background-color="#28a745"
        color="#ffffff"
        font-size="16px"
        border-radius="5px"
        padding="20px"
      ></mj-button>
    </mj-attributes>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <!-- Verification Content -->
    <mj-section background-color="#ffffff" padding="20px">
      <mj-column width="100%">
        <mj-image
          width="80px"
          src="https://placeholder.pics/svg/80x80/28a745/ffffff/Check"
          alt="Verification Icon"
          padding="10px 0"
        ></mj-image>
        <mj-text font-size="20px" font-weight="bold" padding="10px 0"
          >Verify Your Email Address</mj-text
        >
        <mj-text padding="10px 0">
          Thanks for signing up! Please confirm your email address by clicking
          the button below. This helps us keep your account secure.
        </mj-text>
        <mj-button href={url}> Verify My Account </mj-button>
        <mj-text font-size="14px" color="#999999" padding="20px 0 0 0">
          If you did not create this account, you can safely ignore this email.
        </mj-text>
      </mj-column>
    </mj-section>

    <EmailFooter appName={"Xinity"} supportEmail={"support@xinity.ai"} />
  </mj-body>
</mjml>
