<script lang="ts">
  import type { Snippet } from "svelte";

  const {
    style = "",
    background,
    children,
  }: { style?: string; background?: string; children: Snippet } = $props();

  const textStyle = "font-family:Helvetica, Arial, sans-serif;font-size:16px;line-height:1.5;color:#333333";
</script>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tbody>
    <tr>
      {#if background}
        <td style="padding:10px 25px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tbody>
              <tr>
                <td style="{textStyle};padding:15px;background-color:{background};border-radius:5px;{style}">
                  {@render children()}
                </td>
              </tr>
            </tbody>
          </table>
        </td>
      {:else}
        <td style="padding:10px 25px;{textStyle};{style}">
          {@render children()}
        </td>
      {/if}
    </tr>
  </tbody>
</table>
