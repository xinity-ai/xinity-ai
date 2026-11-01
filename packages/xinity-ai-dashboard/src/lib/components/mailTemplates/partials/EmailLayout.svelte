<script lang="ts">
  import type { Snippet } from "svelte";
  import EmailImage from "./EmailImage.svelte";
  import EmailText from "./EmailText.svelte";

  const {
    title,
    preview,
    appName = "Xinity",
    preferencesUrl = "",
    children,
  }: {
    title: string;
    preview: string;
    appName?: string;
    preferencesUrl?: string;
    children: Snippet;
  } = $props();

  const logoUrl = "https://framerusercontent.com/images/aqnKgZbZuWGv4KrGUO9b9Fi9SR4.png";
  const supportEmail = "support@xinity.ai";

  // Svelte drops template comments, so Outlook's conditional comment has to go through @html.
  // Without it, Outlook on high-DPI Windows scales the fixed pixel layout.
  const outlookDpiFix =
    "<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->";
</script>

<svelte:head>
  <title>{title}</title>
  {@html outlookDpiFix}
  <style>
    #outlook a {
      padding: 0;
    }
    body {
      margin: 0;
      padding: 0;
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }
    table,
    td {
      border-collapse: collapse;
      mso-table-lspace: 0pt;
      mso-table-rspace: 0pt;
    }
    img {
      border: 0;
      height: auto;
      line-height: 100%;
      outline: none;
      text-decoration: none;
      -ms-interpolation-mode: bicubic;
    }
    @media (max-width: 620px) {
      .email-container {
        width: 100% !important;
      }
      .email-column {
        display: block !important;
        width: 100% !important;
      }
    }
  </style>
</svelte:head>

<div
  style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all"
>
  {preview}
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f4">
  <tbody>
    <tr>
      <td align="center">
        <table
          role="presentation"
          class="email-container"
          width="600"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="width:600px"
        >
          <tbody>
            <tr>
              <td style="background-color:#ffffff;padding:20px">
                <EmailImage src={logoUrl} alt="Xinity" width={100} />
              </td>
            </tr>
            <tr>
              <td style="background-color:#ffffff;padding:20px">
                {@render children()}
              </td>
            </tr>
            <tr>
              <td style="padding:20px">
                <EmailText style="text-align:center;font-size:12px;color:#999999">
                  You are receiving this email because you're a registered user of {appName}.
                  <br />
                  Need help?
                  <a href="mailto:{supportEmail}" style="color:#999999">Contact Support</a>
                  {#if preferencesUrl}
                    &nbsp;|&nbsp;
                    <a href={preferencesUrl} style="color:#999999">Manage notification preferences</a>
                  {/if}
                </EmailText>
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  </tbody>
</table>
