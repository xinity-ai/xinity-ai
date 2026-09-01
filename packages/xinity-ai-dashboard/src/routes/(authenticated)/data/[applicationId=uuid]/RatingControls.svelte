<script lang="ts">
  import { ThumbsUp, ThumbsDown } from "@lucide/svelte";

  let { value = null, isEdited = false, disabled = false, onRate }: {
    value?: boolean | null;
    isEdited?: boolean;
    disabled?: boolean;
    onRate: (rating: boolean) => void;
  } = $props();
</script>

<div class="rating-controls">
  <button
    type="button"
    class="rating-btn {value === true ? 'liked' : ''}"
    onclick={() => onRate(true)}
    {disabled}
    title="Helpful"
  >
    <ThumbsUp />
  </button>

  <button
    type="button"
    class="rating-btn {value === false ? 'disliked' : ''}"
    onclick={() => onRate(false)}
    {disabled}
    title="Not helpful"
  >
    <ThumbsDown />
  </button>

  {#if isEdited}
    <span class="edit-status">Rating will reset on save</span>
  {/if}
</div>
