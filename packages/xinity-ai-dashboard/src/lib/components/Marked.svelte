<script lang="ts">
  import { identity } from "$lib/util";
  import { marked, type MarkedOptions } from "marked";

  export let message: string;

  const hooks = {
    options: {},
    postprocess(html: string) {
      return html.replaceAll("<a ", '<a target="_blank" ');
    },
    preprocess: identity,
    processAllTokens: identity,
  } as MarkedOptions["hooks"];

  $: renderedMessage = marked(message, { gfm: true, hooks });
</script>

<div class="max-w-full">
  {@html renderedMessage}
</div>

<span data-message={message} data-rendered={renderedMessage}></span>

<style lang="postcss">
  div :global(a) {
    @apply text-purple-400;
  }
  div :global(ul) {
    @apply list-disc pl-4;
  }
  div :global(ol) {
    @apply list-decimal pl-4;
  }
  div :global(table) {
    @apply w-full border-collapse border border-gray-300 overflow-auto;
  }
  div :global(table th),
  div :global(table td) {
    @apply border border-gray-300 p-2;
  }
  div :global(table th) {
    @apply bg-gray-200 text-gray-700 font-semibold;
  }
</style>
