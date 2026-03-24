<script lang="ts">
  import { ThumbsUp, ThumbsDown } from "@lucide/svelte";

  let { value = null, isEdited = false, onRate } = $props<{
    value?: boolean | null;
    isEdited?: boolean;
    onRate: (rating: boolean) => void;
  }>();
</script>

<div class="rating-controls">
  <button
    type="button"
    class="rating-btn {value === true ? 'liked' : ''}"
    onclick={() => onRate(true)}
    title="Helpful"
  >
    <ThumbsUp />
  </button>

  <button
    type="button"
    class="rating-btn {value === false ? 'disliked' : ''}"
    onclick={() => onRate(false)}
    title="Not helpful"
  >
    <ThumbsDown />
  </button>

  {#if isEdited}
    <span class="edit-status">Rating will reset on save</span>
  {/if}
</div>
