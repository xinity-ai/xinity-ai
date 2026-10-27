<script lang="ts">
  import type { Snippet } from "svelte";
  import { Eye, CircleCheck } from "@lucide/svelte";
  import type { ModelSelection } from "./model-selection.svelte";

  const { selection, children }: { selection: ModelSelection; children?: Snippet } = $props();
</script>

<section class="mb-6 bg-white rounded-lg shadow-md p-6">
  <h2 class="text-2xl font-bold mb-2">1. Choose your models</h2>
  <p class="text-gray-600 mb-4">
    Your organization's chat deployments that support tool calling. Deployments without it
    are left out, because an agent cannot read or edit a file without it.
  </p>

  {#if selection.models.length === 0}
    <p class="mb-4 p-4 rounded bg-xinity-coral/10 text-gray-700">
      No chat deployment in your organization supports tool calling yet, so the config below
      uses a placeholder name. Deploy a tool-capable model in the
      <a href="/modelhub/" class="text-xinity-magenta hover:text-xinity-pink">Model Hub</a> first.
    </p>
  {:else}
    <ul class="space-y-2 mb-6">
      {#each selection.models as model (model.publicSpecifier)}
        <li>
          <label class="flex items-center gap-3 p-3 rounded border cursor-pointer hover:bg-gray-50">
            <input
              type="checkbox"
              checked={selection.selected.includes(model.publicSpecifier)}
              onchange={() => selection.toggle(model.publicSpecifier)}
              class="accent-xinity-purple"
            />
            <span class="flex-1">
              <span class="font-medium">{model.name}</span>
              <code class="ml-2 text-sm text-gray-500">{model.publicSpecifier}</code>
            </span>
            {#if model.vision}
              <span class="inline-flex items-center gap-1 text-xs text-xinity-purple" title="Accepts images, declared as a modality in the config">
                <Eye class="w-3 h-3" /> vision
              </span>
            {/if}
            {#if model.ready}
              <span class="inline-flex items-center gap-1 text-xs text-green-600" title="Serving now">
                <CircleCheck class="w-3 h-3" /> ready
              </span>
            {/if}
          </label>
        </li>
      {/each}
    </ul>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <label class="block">
        <span class="block text-sm font-medium mb-1">Default model</span>
        <select
          value={selection.primary}
          onchange={e => (selection.primary = e.currentTarget.value)}
          class="w-full border rounded px-3 py-2"
        >
          {#each selection.entries as model (model.publicSpecifier)}
            <option value={model.publicSpecifier}>{model.name}</option>
          {/each}
        </select>
      </label>
      {@render children?.()}
    </div>
  {/if}
</section>

<style>
  code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }
</style>
