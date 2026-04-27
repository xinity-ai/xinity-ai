<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import * as Alert from "$lib/components/ui/alert";
  import { X, Send, Plus, Trash2, RotateCcw } from "@lucide/svelte";

  import type { DeploymentDefinition } from "./+page.server";
  import { browserLogger } from "$lib/browserLogging";
  import TestApiKeySection from "./TestApiKeySection.svelte";

  const DEFAULT_QUERY = "What is the capital of France?";
  const DEFAULT_DOCUMENTS = [
    "Photosynthesis is the process by which green plants convert sunlight into chemical energy stored in glucose molecules. The chloroplasts in plant cells contain chlorophyll, which captures light energy from the sun. This biological mechanism is fundamental to nearly all life on Earth, as it produces the oxygen we breathe and forms the base of most food chains. While reviewing European geography notes last week, I was reminded that Paris is the capital of France, having served as the political and cultural center of the country for over a thousand years. The Calvin cycle and the light-dependent reactions are the two main stages of photosynthesis, each playing a distinct role in turning carbon dioxide and water into sugars.",
    "Sourdough bread relies on a culture of wild yeast and lactobacilli to leaven and flavor the dough. Bakers maintain a starter by feeding it equal parts flour and water on a regular schedule, allowing the microorganisms to multiply. The fermentation process can take anywhere from twelve to twenty-four hours, depending on the room temperature and the activity of the starter. The resulting loaves develop a tangy flavor, an open crumb structure, and a thick, crackling crust. Many home bakers find that maintaining a healthy starter through changes in temperature and feeding schedule is the most challenging part of getting started.",
    "Modern competitive chess has been transformed by the widespread availability of powerful engines and online play. Beginners now have access to instructional videos, puzzle databases, and computer analysis that previous generations could only have dreamed of. Tournaments at the highest level have shortened time controls, with rapid and blitz events drawing increasing attention from sponsors and audiences. Despite these changes, the classical format remains the gold standard for determining world champions, with individual games sometimes lasting five or six hours over a single playing session.",
  ];

  type RankedResult = {
    rank: number;
    inputIndex: number;
    score: number;
    text: string;
  };

  type RerankResult = {
    ranks: RankedResult[];
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
  let query = $state(DEFAULT_QUERY);
  let documents = $state<string[]>([...DEFAULT_DOCUMENTS]);
  let result = $state<RerankResult | null>(null);
  let errorMessage = $state<string | null>(null);
  let sending = $state(false);
  let queryEl = $state<HTMLTextAreaElement | null>(null);
  let inflight: AbortController | null = null;

  const trimmedDocuments = $derived(documents.map((d) => d.trim()).filter(Boolean));
  const canSend = $derived(
    !sending &&
      apiKey.trim().length > 0 &&
      query.trim().length > 0 &&
      trimmedDocuments.length >= 1,
  );
  const canReset = $derived(
    sending ||
      result !== null ||
      errorMessage !== null ||
      query !== DEFAULT_QUERY ||
      !arraysEqual(documents, DEFAULT_DOCUMENTS),
  );

  // Bar width is relative to the largest score in the response so models that
  // emit small or negative scores still produce a readable chart.
  const maxAbsScore = $derived(
    result ? result.ranks.reduce((m, r) => Math.max(m, Math.abs(r.score)), 0) || 1 : 1,
  );

  // Fresh-open reset. Triggers on every false->true transition.
  let wasOpen = $state(false);
  $effect(() => {
    if (open && !wasOpen) {
      resetState();
      queueMicrotask(() => queryEl?.focus());
    }
    wasOpen = open;
  });

  function arraysEqual(a: string[], b: string[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function resetState() {
    inflight?.abort();
    inflight = null;
    sending = false;
    query = DEFAULT_QUERY;
    documents = [...DEFAULT_DOCUMENTS];
    result = null;
    errorMessage = null;
    apiKey = "";
  }

  function resetInputs() {
    inflight?.abort();
    inflight = null;
    sending = false;
    query = DEFAULT_QUERY;
    documents = [...DEFAULT_DOCUMENTS];
    result = null;
    errorMessage = null;
    queueMicrotask(() => queryEl?.focus());
  }

  function setDocument(idx: number, value: string) {
    documents = documents.map((d, i) => (i === idx ? value : d));
  }

  function addDocument() {
    documents = [...documents, ""];
  }

  function removeDocument(idx: number) {
    if (documents.length <= 1) return;
    documents = documents.filter((_, i) => i !== idx);
  }

  async function handleSend() {
    if (!canSend || !deployment) return;
    sending = true;
    errorMessage = null;
    result = null;

    inflight?.abort();
    const ctrl = new AbortController();
    inflight = ctrl;

    const docsForApi = trimmedDocuments;
    const start = performance.now();
    try {
      const res = await fetch("/modelhub/test-rerank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          model: deployment.publicSpecifier,
          query: query.trim(),
          documents: docsForApi,
        }),
      });

      if (!res.ok) {
        errorMessage = await formatErrorBody(res);
        return;
      }

      const json = await res.json();
      const results = json?.results;
      if (!Array.isArray(results)) {
        errorMessage = "Unexpected response shape: missing results array";
        return;
      }

      result = {
        ranks: results.map((r, rankIdx) => normalizeRankRow(r, rankIdx, docsForApi)),
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err) {
      if (ctrl.signal.aborted) return;
      browserLogger.warn({ err }, "Test rerank request failed");
      errorMessage = err instanceof Error ? err.message : "Network error";
    } finally {
      if (inflight === ctrl) inflight = null;
      sending = false;
    }
  }

  // The `document` field can be a raw string, an object with a `text` field, or
  // omitted entirely; fall back to the input we sent so the user always sees
  // which document the rank refers to.
  function normalizeRankRow(
    row: unknown,
    rankIdx: number,
    sentDocs: string[],
  ): RankedResult {
    const r = row as { index?: number; relevance_score?: number; document?: unknown } | null;
    const inputIndex = typeof r?.index === "number" ? r.index : rankIdx;
    const score = typeof r?.relevance_score === "number" ? r.relevance_score : 0;
    let text = "";
    if (typeof r?.document === "string") {
      text = r.document;
    } else if (r?.document && typeof r.document === "object" && "text" in r.document) {
      const t = (r.document as { text?: unknown }).text;
      if (typeof t === "string") text = t;
    }
    if (!text) text = sentDocs[inputIndex] ?? "";
    return { rank: rankIdx + 1, inputIndex, score, text };
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
</script>

<Modal {open} onClose={handleClose} class="z-40">
  {#if open && deployment}
    <div class="bg-card rounded-xl shadow-2xl w-full max-w-3xl min-w-[min(48rem,90vw)] max-h-[90vh] flex flex-col">
      <header class="p-6 border-b flex justify-between items-center">
        <div>
          <h2 class="text-2xl font-semibold">Test Rerank Model</h2>
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
            <Label for="testRerankQuery" class="text-sm font-semibold">Query</Label>
            <Button
              variant="ghost"
              size="sm"
              onclick={resetInputs}
              disabled={!canReset}
              title="Restore defaults and clear results"
            >
              <RotateCcw class="w-4 h-4" />
              Reset
            </Button>
          </div>
          <textarea
            id="testRerankQuery"
            bind:value={query}
            bind:this={queryEl}
            placeholder="The query to rank documents against..."
            rows="2"
            disabled={sending}
            class="w-full min-h-15 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
          ></textarea>
        </section>

        <section class="space-y-2">
          <div class="flex items-center justify-between">
            <Label class="text-sm font-semibold">Documents</Label>
            <Button variant="ghost" size="sm" onclick={addDocument} disabled={sending}>
              <Plus class="w-4 h-4" />
              Add document
            </Button>
          </div>
          <div class="space-y-2">
            {#each documents as doc, i (i)}
              <div class="flex items-start gap-2">
                <textarea
                  value={doc}
                  oninput={(e) => setDocument(i, e.currentTarget.value)}
                  placeholder="Document {i + 1}"
                  rows="5"
                  disabled={sending}
                  class="flex-1 min-h-28 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                ></textarea>
                <Button
                  variant="outline"
                  size="icon"
                  onclick={() => removeDocument(i)}
                  disabled={sending || documents.length <= 1}
                  title="Remove document"
                >
                  <Trash2 class="w-4 h-4" />
                </Button>
              </div>
            {/each}
          </div>
        </section>

        {#if errorMessage}
          <Alert.Root variant="destructive">
            <Alert.Description>{errorMessage}</Alert.Description>
          </Alert.Root>
        {/if}

        {#if result}
          <section class="space-y-3">
            <div class="flex items-center justify-between">
              <Label class="text-sm font-semibold">Ranked results</Label>
              <span class="text-xs text-muted-foreground">{result.durationMs} ms</span>
            </div>
            <div class="space-y-2">
              {#each result.ranks as r (r.rank)}
                <div class="rounded-md border bg-muted/40 p-3">
                  <div class="flex items-baseline justify-between gap-2 mb-2">
                    <div class="flex items-baseline gap-2">
                      <span class="font-mono text-sm font-semibold">#{r.rank}</span>
                      <span class="text-xs text-muted-foreground">input {r.inputIndex + 1}</span>
                    </div>
                    <span class="font-mono text-sm">{r.score.toFixed(4)}</span>
                  </div>
                  <div class="w-full bg-muted rounded-full h-1.5 mb-2">
                    <div
                      class="bg-primary h-1.5 rounded-full transition-all"
                      style="width: {Math.max(0, Math.min(100, (Math.abs(r.score) / maxAbsScore) * 100))}%"
                    ></div>
                  </div>
                  <p class="text-sm whitespace-pre-wrap wrap-break-words">{r.text}</p>
                </div>
              {/each}
            </div>
          </section>
        {/if}

        {#if !apiKey.trim()}
          <Alert.Root>
            <Alert.Description class="text-xs">
              Paste an API key or click "Generate temporary key" to rank documents.
            </Alert.Description>
          </Alert.Root>
        {/if}
      </main>

      <footer class="p-4 border-t bg-muted/40 rounded-b-xl flex justify-end gap-2">
        <Button onclick={handleSend} disabled={!canSend}>
          <Send class="w-4 h-4" />
          {sending ? "Ranking..." : "Rank documents"}
        </Button>
      </footer>
    </div>
  {/if}
</Modal>
