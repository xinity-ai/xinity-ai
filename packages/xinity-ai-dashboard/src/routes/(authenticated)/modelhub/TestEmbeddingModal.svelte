<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import * as Alert from "$lib/components/ui/alert";
  import { Send, Copy, RotateCcw } from "@lucide/svelte";

  import type { DeploymentDefinition } from "./+page.server";
  import { browserLogger } from "$lib/browserLogging";
  import { copyToClipboard } from "$lib/copy";
  import TestModal from "./TestModal.svelte";
  import { formatErrorBody } from "./testHelpers";

  const DEFAULT_INPUT = "The quick brown fox jumps over the lazy dog.";
  const PREVIEW_HEAD = 6;
  const PREVIEW_TAIL = 2;

  type EmbedResult = {
    embedding: number[];
    promptTokens: number;
    totalTokens: number;
    durationMs: number;
  };

  let {
    open = $bindable(false),
    deployment,
    close,
  }: {
    open: boolean;
    deployment: DeploymentDefinition | null;
    close: () => void;
  } = $props();

  let apiKey = $state("");
  let inputText = $state(DEFAULT_INPUT);
  let result = $state<EmbedResult | null>(null);
  let errorMessage = $state<string | null>(null);
  let sending = $state(false);
  let inputEl = $state<HTMLTextAreaElement | null>(null);
  let inflight: AbortController | null = null;

  const canSend = $derived(
    !sending && apiKey.trim().length > 0 && inputText.trim().length > 0,
  );
  const canReset = $derived(
    sending || result !== null || errorMessage !== null || inputText !== DEFAULT_INPUT,
  );

  function clearOutputs() {
    inflight?.abort();
    inflight = null;
    sending = false;
    inputText = DEFAULT_INPUT;
    result = null;
    errorMessage = null;
  }

  function resetState() {
    clearOutputs();
    apiKey = "";
  }

  function resetInput() {
    clearOutputs();
    queueMicrotask(() => inputEl?.focus());
  }

  function handleOpen() {
    resetState();
    queueMicrotask(() => inputEl?.focus());
  }

  function handleClose() {
    inflight?.abort();
    close();
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
      const res = await fetch("/modelhub/test-embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          model: deployment.publicSpecifier,
          input: inputText,
        }),
      });

      if (!res.ok) {
        errorMessage = await formatErrorBody(res);
        return;
      }

      const json = await res.json();
      const embedding = json?.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        errorMessage = "Unexpected response shape: missing embedding vector";
        return;
      }
      result = {
        embedding,
        promptTokens: json?.usage?.prompt_tokens ?? 0,
        totalTokens: json?.usage?.total_tokens ?? 0,
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err) {
      if (ctrl.signal.aborted) {
        return;
      }
      browserLogger.warn({ err }, "Test embedding request failed");
      errorMessage = err instanceof Error ? err.message : "Network error";
    } finally {
      if (inflight === ctrl) {
        inflight = null;
      }
      sending = false;
    }
  }

  function copyVector() {
    if (!result) {
      return;
    }
    copyToClipboard(JSON.stringify(result.embedding));
  }

  function previewVector(v: number[]): string {
    const fmt = (n: number) => n.toFixed(4);
    if (v.length <= PREVIEW_HEAD + PREVIEW_TAIL + 1) {
      return v.map(fmt).join(", ");
    }
    const head = v.slice(0, PREVIEW_HEAD).map(fmt).join(", ");
    const tail = v.slice(-PREVIEW_TAIL).map(fmt).join(", ");
    return `${head}, ..., ${tail}`;
  }
</script>

<TestModal
  bind:open
  {deployment}
  title="Test Embedding Model"
  bind:apiKey
  apiKeyHint={'Paste an API key or click "Generate temporary key" to compute an embedding.'}
  onClose={handleClose}
  onOpen={handleOpen}
>
  {#snippet body()}
    <section class="space-y-2">
      <div class="flex items-center justify-between">
        <Label for="testEmbedInput" class="text-sm font-semibold">Input</Label>
        <Button
          variant="ghost"
          size="sm"
          onclick={resetInput}
          disabled={!canReset}
          title="Clear input and result"
        >
          <RotateCcw class="w-4 h-4" />
          Reset
        </Button>
      </div>
      <textarea
        id="testEmbedInput"
        bind:value={inputText}
        bind:this={inputEl}
        placeholder="Text to embed..."
        rows="4"
        disabled={sending}
        class="w-full min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
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
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div class="rounded-md border bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">Dimensions</div>
            <div class="font-mono text-sm">{result.embedding.length}</div>
          </div>
          <div class="rounded-md border bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">Prompt tokens</div>
            <div class="font-mono text-sm">{result.promptTokens}</div>
          </div>
          <div class="rounded-md border bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">Total tokens</div>
            <div class="font-mono text-sm">{result.totalTokens}</div>
          </div>
          <div class="rounded-md border bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">Duration</div>
            <div class="font-mono text-sm">{result.durationMs} ms</div>
          </div>
        </div>
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <Label class="text-sm font-semibold">Vector preview</Label>
            <Button variant="outline" size="sm" onclick={copyVector}>
              <Copy class="w-4 h-4" />
              Copy full vector
            </Button>
          </div>
          <div class="rounded-md border bg-background px-3 py-2 font-mono text-xs break-all">
            [{previewVector(result.embedding)}]
          </div>
        </div>
      </section>
    {/if}
  {/snippet}

  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button onclick={handleSend} disabled={!canSend}>
        <Send class="w-4 h-4" />
        {sending ? "Computing..." : "Compute embedding"}
      </Button>
    </div>
  {/snippet}
</TestModal>
