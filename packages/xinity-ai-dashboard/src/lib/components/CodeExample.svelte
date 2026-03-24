<script lang="ts">
  import { copyToClipboard } from "$lib/copy";
  import Prism from "prismjs";
  import "prismjs/components/prism-python.min.js";
  import "prismjs/components/prism-javascript.min.js";
  import "prismjs/components/prism-bash.min.js";
  import CopyIcon from "$lib/components/icons/CopyIcon.svelte";

  const {
    code,
    language,
    withCopy = false,
  }: {
    code: string;
    language: "javascript" | "bash" | "python";
    withCopy?: boolean;
  } = $props();

  let codeEl: HTMLElement | undefined = $state();

  $effect(() => {
    if (codeEl) {
      codeEl.textContent = code;
      codeEl.className = `language-${language}`;
      Prism.highlightElement(codeEl);
    }
  });
</script>

<svelte:head>
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css"
  />
</svelte:head>

<div class="relative">
  {#if withCopy}
    <button
      class="copy-btn inline-flex items-center border-0 bg-transparent p-0 ml-2 justify-center absolute top-4 right-4 px-3 py-1 text-white text-sm rounded transition"
      aria-label="copy"
      title="Copy"
      onclick={() => copyToClipboard(code)}
    >
      <CopyIcon></CopyIcon>
    </button>
  {/if}
  <pre
    class="bg-[#f5f2f0] text-gray-100 p-4 rounded-lg overflow-x-auto text-sm"><code
      bind:this={codeEl}
      class="language-{language}">{code}</code
    ></pre>
</div>

<style>
  /* Copy button styling */
  .copy-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    margin-left: 8px;
    background-color: transparent;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .copy-btn:hover {
    background-color: rgba(0, 0, 0, 0.05);
  }

  .copy-btn :global(svg) {
    width: 16px;
    height: 16px;
    fill: #6b7280;
  }
</style>
