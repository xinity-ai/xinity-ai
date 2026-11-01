<script lang="ts">
  import type { Snippet } from "svelte";

  const { href, color = "#007BFF", children }: { href: string; color?: string; children: Snippet } = $props();
</script>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tbody>
    <tr>
      <td align="center" style="padding:20px 25px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tbody>
            <tr>
              <td style="border-radius:5px;background-color:{color};mso-padding-alt:12px 24px">
                <a
                  {href}
                  target="_blank"
                  style="display:inline-block;padding:12px 24px;mso-padding-alt:0;font-family:Helvetica, Arial, sans-serif;font-size:16px;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:5px"
                >
                  {@render children()}
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  </tbody>
</table>
