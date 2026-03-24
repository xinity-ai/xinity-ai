<script lang="ts">
  import { ThumbsUp, ThumbsDown, X } from "@lucide/svelte";

  let {
    visible = false,
    x = 0,
    y = 0,
    onSelect,
    showClear = false,
    onClear,
    onMouseEnter,
    onMouseLeave,
  } = $props<{
    visible?: boolean;
    x?: number;
    y?: number;
    onSelect: (type: "positive" | "negative") => void;
    showClear?: boolean;
    onClear?: () => void;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
  }>();
</script>

{#if visible}
  <div
    class="highlight-popup"
    role="group"
    style="left: {x}px; top: {y}px;"
    onmouseenter={() => onMouseEnter?.()}
    onmouseleave={() => onMouseLeave?.()}
  >
    <button
      type="button"
      class="highlight-popup-btn positive-btn"
      title="Mark as positive"
      onclick={() => onSelect("positive")}
    >
      <ThumbsUp class="w-5 h-5" />
    </button>
    <button
      type="button"
      class="highlight-popup-btn negative-btn"
      title="Mark as negative"
      onclick={() => onSelect("negative")}
    >
      <ThumbsDown class="w-5 h-5" />
    </button>
    {#if showClear}
      <button
        type="button"
        class="highlight-popup-btn neutral-btn"
        title="Remove rating"
        onclick={() => onClear?.()}
      >
        <X class="w-5 h-5" />
      </button>
    {/if}
  </div>
{/if}
