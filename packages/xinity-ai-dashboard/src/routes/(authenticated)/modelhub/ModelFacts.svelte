<script lang="ts">
  import { resolveOptimizeFor, type DeploymentSettings } from "common-env/deployment-settings";
  import { Copy } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { copyToClipboard } from "$lib/copy";
  import { OPTIMIZATION_GOAL_DISPLAY } from "./optimization-goals";

  let {
    model,
    caption,
  }: {
    model: { specifier: string; kvCacheSize?: number | null; preferredDriver?: string | null; settings?: DeploymentSettings };
    caption?: string;
  } = $props();

  const DRIVER_LABELS: Record<string, string> = { vllm: "vLLM", ollama: "Ollama" };

  const facts = $derived([
    ["KV cache", model.kvCacheSize ? `${model.kvCacheSize} GB` : "Model default"],
    ["Driver", model.preferredDriver ? DRIVER_LABELS[model.preferredDriver] ?? model.preferredDriver : "From the model entry"],
    ["Optimized for", OPTIMIZATION_GOAL_DISPLAY[resolveOptimizeFor(model.settings)].label],
    ...(model.settings?.maxAudioInputDurationS ? [["Max audio length", `${model.settings.maxAudioInputDurationS} s`]] : []),
    ...(model.settings?.maxAudioInputFileSizeMB ? [["Max audio file", `${model.settings.maxAudioInputFileSizeMB} MB`]] : []),
  ]);
</script>

<div class="space-y-2">
  {#if caption}
    <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{caption}</p>
  {/if}
  <div class="flex items-center gap-2 min-w-0">
    <p class="font-mono text-sm font-medium truncate" title={model.specifier}>{model.specifier}</p>
    <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" onclick={() => copyToClipboard(model.specifier)} title="Copy model specifier">
      <Copy class="w-3 h-3" />
    </Button>
  </div>
  <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
    {#each facts as [label, value] (label)}
      <dt class="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    {/each}
  </dl>
</div>
