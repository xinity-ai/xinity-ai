<script lang="ts">
  import type { Snippet } from "svelte";
  import { Button, type ButtonProps } from "$lib/components/ui/button";
  import { LoaderCircle } from "@lucide/svelte";

  let {
    pending,
    pendingLabel,
    disabled,
    children,
    ...rest
  }: ButtonProps & { pending: boolean; pendingLabel?: string; children: Snippet } = $props();
</script>

<Button {...rest} disabled={disabled || pending}>
  {#if pending}
    <LoaderCircle class="w-4 h-4 animate-spin" />
    {#if pendingLabel}
      {pendingLabel}
    {:else}
      {@render children()}
    {/if}
  {:else}
    {@render children()}
  {/if}
</Button>
