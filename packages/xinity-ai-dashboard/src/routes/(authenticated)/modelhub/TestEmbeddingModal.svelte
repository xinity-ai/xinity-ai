<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import * as Alert from "$lib/components/ui/alert";
  import { X, Send, Copy, RotateCcw } from "@lucide/svelte";

  import type { DeploymentDefinition } from "./+page.server";
  import { browserLogger } from "$lib/browserLogging";
  import { copyToClipboard } from "$lib/copy";
  import TestApiKeySection from "./TestApiKeySection.svelte";

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

  // Fresh-open reset. Triggers on every false->true transition.
  let wasOpen = $state(false);
  $effect(() => {
    if (open && !wasOpen) {
      resetState();
      queueMicrotask(() => inputEl?.focus());
    }
    wasOpen = open;
  });

  function resetState() {
    inflight?.abort();
    inflight = null;
    sending = false;
    inputText = DEFAULT_INPUT;
    result = null;
    errorMessage = null;
    apiKey = "";
  }

  function resetInput() {
    inflight?.abort();
    inflight = null;
    sending = false;
    inputText = DEFAULT_INPUT;
    result = null;
    errorMessage = null;
    queueMicrotask(() => inputEl?.focus());
  }

  async function handleSend() {
    if (!canSend || !deployment) return;
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
      if (ctrl.signal.aborted) return;
      browserLogger.warn({ err }, "Test embedding request failed");
      errorMessage = err instanceof Error ? err.message : "Network error";
    } finally {
      if (inflight === ctrl) inflight = null;
      sending = false;
    }
  }

  async function formatErrorBody(res: Response): Promise<string> {
    const text = await res.text().catch(() => "");
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error?.message) return String(parsed.error.message);
    } catch {
      /* fall through to raw text */
    }
    return text || `Request failed (${res.status})`;
  }

  function handleClose() {
    inflight?.abort();
    close();
  }

  function copyVector() {
    if (!result) return;
    copyToClipboard(JSON.stringify(result.embedding));
  }

  function previewVector(v: number[]): string {
    const fmt = (n: number) => n.toFixed(4);
    if (v.length <= PREVIEW_HEAD + PREVIEW_TAIL + 1) return v.map(fmt).join(", ");
    const head = v.slice(0, PREVIEW_HEAD).map(fmt).join(", ");
    const tail = v.slice(-PREVIEW_TAIL).map(fmt).join(", ");
    return `${head}, ..., ${tail}`;
  }
</script>

<Modal {open} onClose={handleClose} class="z-40">
  {#if open && deployment}
    <div class="bg-card rounded-xl shadow-2xl w-full max-w-3xl min-w-[min(48rem,90vw)] max-h-[90vh] flex flex-col">
      <header class="p-6 border-b flex justify-between items-center">
        <div>
          <h2 class="text-2xl font-semibold">Test Embedding Model</h2>
          <p class="text-sm text-muted-foreground mt-1">
            <span class="font-mono">{deployment.publicSpecifier}</span>
          </p>
        </div>
        <Button variant="ghost" size="icon" onclick={handleClose} aria-label="Close test modal">
          <X class="w-5 h-5" />
        </Button>
      </header>

      <main class="p-6 flex-1 overflow-y-auto space-y-5">
        <TestApiKeySection bind:apiKey deploymentName={deployment.name} />

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

        {#if !apiKey.trim()}
          <Alert.Root>
            <Alert.Description class="text-xs">
              Paste an API key or click "Generate temporary key" to compute an embedding.
            </Alert.Description>
          </Alert.Root>
        {/if}
      </main>

      <footer class="p-4 border-t bg-muted/40 rounded-b-xl flex justify-end gap-2">
        <Button onclick={handleSend} disabled={!canSend}>
          <Send class="w-4 h-4" />
          {sending ? "Computing..." : "Compute embedding"}
        </Button>
      </footer>
    </div>
  {/if}
</Modal>
