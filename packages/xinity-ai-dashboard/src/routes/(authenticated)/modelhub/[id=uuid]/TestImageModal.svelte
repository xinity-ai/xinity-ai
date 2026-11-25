<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import * as Alert from "$lib/components/ui/alert";
  import { Send, RotateCcw } from "@lucide/svelte";

  import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
  import { browserLogger } from "$lib/browserLogging";
  import TestModal from "./TestModal.svelte";
  import { formatErrorBody } from "./testHelpers";

  const DEFAULT_PROMPT = "A red apple on a wooden table, soft morning light.";

  type ImageResult = {
    src: string;
    size: string | null;
    durationMs: number;
  };

  let {
    open = $bindable(false),
    deployment,
    close,
  }: {
    open: boolean;
    deployment: DeploymentOutput | null;
    close: () => void;
  } = $props();

  let apiKey = $state("");
  let prompt = $state(DEFAULT_PROMPT);
  let result = $state<ImageResult | null>(null);
  let errorMessage = $state<string | null>(null);
  let sending = $state(false);
  let promptEl = $state<HTMLTextAreaElement | null>(null);
  let inflight: AbortController | null = null;

  const canSend = $derived(!sending && apiKey.trim().length > 0 && prompt.trim().length > 0);
  const canReset = $derived(sending || result !== null || errorMessage !== null || prompt !== DEFAULT_PROMPT);

  function clearOutputs() {
    inflight?.abort();
    inflight = null;
    sending = false;
    prompt = DEFAULT_PROMPT;
    result = null;
    errorMessage = null;
  }

  function resetState() {
    clearOutputs();
    apiKey = "";
  }

  function resetInput() {
    clearOutputs();
    queueMicrotask(() => promptEl?.focus());
  }

  function handleOpen() {
    resetState();
    queueMicrotask(() => promptEl?.focus());
  }

  function handleClose() {
    inflight?.abort();
    close();
  }

  function mediaTypeOf(outputFormat: unknown): string {
    if (outputFormat === "jpeg" || outputFormat === "jpg") {
      return "image/jpeg";
    }
    return outputFormat === "webp" ? "image/webp" : "image/png";
  }

  async function handleSend() {
    if (!canSend || !deployment) {
      return;
    }
    sending = true;
    errorMessage = null;
    result = null;

    inflight?.abort();
    const ctrl = new AbortController();
    inflight = ctrl;

    const start = performance.now();
    try {
      const res = await fetch("/modelhub/test-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          model: deployment.publicSpecifier,
          prompt,
        }),
      });

      if (!res.ok) {
        errorMessage = await formatErrorBody(res);
        return;
      }

      const json = await res.json();
      const b64 = json?.data?.[0]?.b64_json;
      if (typeof b64 !== "string" || b64.length === 0) {
        errorMessage = "Unexpected response shape: missing image data";
        return;
      }
      result = {
        src: `data:${mediaTypeOf(json?.output_format)};base64,${b64}`,
        size: typeof json?.size === "string" ? json.size : null,
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err) {
      if (ctrl.signal.aborted) {
        return;
      }
      browserLogger.warn({ err }, "Test image request failed");
      errorMessage = err instanceof Error ? err.message : "Network error";
    } finally {
      if (inflight === ctrl) {
        inflight = null;
      }
      sending = false;
    }
  }
</script>

<TestModal
  bind:open
  {deployment}
  title="Test Image Model"
  bind:apiKey
  apiKeyHint={'Paste an API key or click "Generate temporary key" to generate an image.'}
  onClose={handleClose}
  onOpen={handleOpen}
>
  {#snippet body()}
    <section class="space-y-2">
      <div class="flex items-center justify-between">
        <Label for="testImagePrompt" class="text-sm font-semibold">Prompt</Label>
        <Button
          variant="ghost"
          size="sm"
          onclick={resetInput}
          disabled={!canReset}
          title="Clear prompt and result"
        >
          <RotateCcw class="w-4 h-4" />
          Reset
        </Button>
      </div>
      <textarea
        id="testImagePrompt"
        bind:value={prompt}
        bind:this={promptEl}
        placeholder="Describe the image..."
        rows="3"
        disabled={sending}
        class="w-full min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
      ></textarea>
    </section>

    {#if errorMessage}
      <Alert.Root variant="destructive">
        <Alert.Description>{errorMessage}</Alert.Description>
      </Alert.Root>
    {/if}

    {#if result}
      <section class="space-y-3">
        <Label class="text-sm font-semibold">Result</Label>
        <div class="grid grid-cols-2 gap-2">
          <div class="rounded-md border bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">Size</div>
            <div class="font-mono text-sm">{result.size ?? "unknown"}</div>
          </div>
          <div class="rounded-md border bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">Duration</div>
            <div class="font-mono text-sm">{result.durationMs} ms</div>
          </div>
        </div>
        <img src={result.src} alt="Generated from the prompt" class="mx-auto max-h-[60vh] rounded-md border object-contain" />
      </section>
    {/if}
  {/snippet}

  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button onclick={handleSend} disabled={!canSend}>
        <Send class="w-4 h-4" />
        {sending ? "Generating..." : "Generate image"}
      </Button>
    </div>
  {/snippet}
</TestModal>
