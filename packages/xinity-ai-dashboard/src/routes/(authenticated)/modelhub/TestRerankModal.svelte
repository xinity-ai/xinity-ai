<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import * as Alert from "$lib/components/ui/alert";
  import { Send, Plus, Trash2, RotateCcw } from "@lucide/svelte";

  import type { DeploymentDefinition } from "./+page.server";
  import { browserLogger } from "$lib/browserLogging";
  import TestModal from "./TestModal.svelte";
  import { formatErrorBody } from "./testHelpers";

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

  // Bar width is relative to the largest score so models that emit small or
  // negative scores still produce a readable chart.
  const maxAbsScore = $derived(
    result ? result.ranks.reduce((m, r) => Math.max(m, Math.abs(r.score)), 0) || 1 : 1,
  );

  function arraysEqual(a: string[], b: string[]) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  function clearInputs() {
    inflight?.abort();
    inflight = null;
    sending = false;
    query = DEFAULT_QUERY;
    documents = [...DEFAULT_DOCUMENTS];
    result = null;
    errorMessage = null;
  }

  function resetState() {
    clearInputs();
    apiKey = "";
  }

  function resetInputs() {
    clearInputs();
    queueMicrotask(() => queryEl?.focus());
  }

  function handleOpen() {
    resetState();
    queueMicrotask(() => queryEl?.focus());
  }

  function handleClose() {
    inflight?.abort();
    close();
  }

  function setDocument(idx: number, value: string) {
    documents = documents.map((d, i) => (i === idx ? value : d));
  }

  function addDocument() {
    documents = [...documents, ""];
  }

  function removeDocument(idx: number) {
    if (documents.length <= 1) {
      return;
    }
    documents = documents.filter((_, i) => i !== idx);
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
      if (ctrl.signal.aborted) {
        return;
      }
      browserLogger.warn({ err }, "Test rerank request failed");
      errorMessage = err instanceof Error ? err.message : "Network error";
    } finally {
      if (inflight === ctrl) {
        inflight = null;
      }
      sending = false;
    }
  }

  // The `document` field can be a raw string, an object with a `text` field, or
  // omitted entirely; fall back to the input we sent so the rank always shows text.
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
      if (typeof t === "string") {
        text = t;
      }
    }
    if (!text) {
      text = sentDocs[inputIndex] ?? "";
    }
    return { rank: rankIdx + 1, inputIndex, score, text };
  }
</script>

<TestModal
  bind:open
  {deployment}
  title="Test Rerank Model"
  bind:apiKey
  apiKeyHint={'Paste an API key or click "Generate temporary key" to rank documents.'}
  onClose={handleClose}
  onOpen={handleOpen}
>
  {#snippet body()}
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
  {/snippet}

  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button onclick={handleSend} disabled={!canSend}>
        <Send class="w-4 h-4" />
        {sending ? "Ranking..." : "Rank documents"}
      </Button>
    </div>
  {/snippet}
</TestModal>
