<script lang="ts">
  const { src, alt, width }: { src: string; alt: string; width: number } = $props();
</script>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tbody>
    <tr>
      <td align="center" style="padding:10px 25px">
        <img
          {src}
          {alt}
          {width}
          style="display:block;border:0;width:{width}px;max-width:100%;height:auto"
        />
      </td>
    </tr>
  </tbody>
</table>
