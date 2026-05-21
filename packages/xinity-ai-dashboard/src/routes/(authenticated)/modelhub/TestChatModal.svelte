<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import * as Select from "$lib/components/ui/select";
  import { Send, RotateCcw } from "@lucide/svelte";

  import type { ApplicationDto } from "$lib/orpc/dtos/application.dto";
  import type { DeploymentDefinition } from "./+page.server";
  import { browserLogger } from "$lib/browserLogging";
  import TestModal from "./TestModal.svelte";
  import { formatErrorBody } from "./testHelpers";

  type ChatMessage = { role: "user" | "assistant"; content: string; reasoning?: string };

  const DEFAULT_PROMPT = "Hi, introduce yourself";
  const NO_APPLICATION = "__none__";

  let {
    open = $bindable(false),
    deployment,
    applications = [],
    close,
  }: {
    open: boolean;
    deployment: DeploymentDefinition | null;
    applications?: ApplicationDto[];
    close: () => void;
  } = $props();

  let apiKey = $state("");

  let storeCall = $state(false);
  let selectedApplicationId = $state<string>(NO_APPLICATION);

  let messages = $state<ChatMessage[]>([]);
  let inputValue = $state(DEFAULT_PROMPT);
  let sending = $state(false);
  let chatScroll = $state<HTMLDivElement | null>(null);
  let inputEl = $state<HTMLTextAreaElement | null>(null);
  let inflight: AbortController | null = null;

  const selectedApplication = $derived(
    selectedApplicationId === NO_APPLICATION
      ? null
      : applications.find((a) => a.id === selectedApplicationId) ?? null,
  );

  const canSend = $derived(
    !sending && apiKey.trim().length > 0 && inputValue.trim().length > 0,
  );

  // Re-scroll on every streamed chunk; track total content length so chunks
  // that don't change message count still fire the effect.
  const totalContentLen = $derived(messages.reduce((n, m) => n + m.content.length + (m.reasoning?.length ?? 0), 0));
  $effect(() => {
    void totalContentLen;
    if (chatScroll && messages.length > 0) {
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }
  });

  function focusInput() {
    queueMicrotask(() => inputEl?.focus());
  }

  function clearTranscript() {
    inflight?.abort();
    inflight = null;
    sending = false;
    messages = [];
    inputValue = DEFAULT_PROMPT;
  }

  function resetChat() {
    clearTranscript();
    focusInput();
  }

  function resetState() {
    clearTranscript();
    apiKey = "";
    storeCall = false;
    selectedApplicationId = NO_APPLICATION;
  }

  function handleOpen() {
    resetState();
    focusInput();
  }

  function handleClose() {
    inflight?.abort();
    close();
  }

  async function handleSend() {
    if (!canSend || !deployment) {
      return;
    }
    const userText = inputValue.trim();
    inputValue = "";
    messages = [
      ...messages,
      { role: "user", content: userText },
      { role: "assistant", content: "" },
    ];
    const assistantIdx = messages.length - 1;
    sending = true;

    inflight?.abort();
    const ctrl = new AbortController();
    inflight = ctrl;

    const applicationName = storeCall ? selectedApplication?.name ?? null : null;

    try {
      const res = await fetch("/modelhub/test-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          model: deployment.publicSpecifier,
          messages: messages
            .slice(0, assistantIdx)
            .map((m) => ({ role: m.role, content: m.content })),
          store: storeCall,
          applicationName,
        }),
      });

      if (!res.ok) {
        appendToAssistant(assistantIdx, `Error: ${await formatErrorBody(res)}`);
        return;
      }
      if (!res.body) {
        appendToAssistant(assistantIdx, "Error: empty response body");
        return;
      }

      await consumeSseStream(res.body, assistantIdx);
    } catch (err) {
      if (ctrl.signal.aborted) {
        return;
      }
      browserLogger.warn({ err }, "Test chat request failed");
      const detail = err instanceof Error ? err.message : "Network error";
      appendToAssistant(assistantIdx, `Error: ${detail}`);
    } finally {
      if (inflight === ctrl) {
        inflight = null;
      }
      sending = false;
      if (!ctrl.signal.aborted) {
        focusInput();
      }
    }
  }

  async function consumeSseStream(body: ReadableStream<Uint8Array>, assistantIdx: number) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nlIdx).replace(/\r$/, "").trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          return;
        }
        try {
          // reasoning_content (DeepSeek/QwQ/vLLM) and reasoning (OpenRouter) both used in the wild.
          const delta = JSON.parse(payload)?.choices?.[0]?.delta;
          const reasoning = delta?.reasoning_content ?? delta?.reasoning;
          if (typeof reasoning === "string" && reasoning.length > 0) {
            appendToAssistant(assistantIdx, reasoning, "reasoning");
          }
          const content = delta?.content;
          if (typeof content === "string" && content.length > 0) {
            appendToAssistant(assistantIdx, content, "content");
          }
        } catch (err) {
          browserLogger.warn({ err, payload }, "Failed to parse SSE chunk");
        }
      }
    }
  }

  function appendToAssistant(idx: number, text: string, channel: "content" | "reasoning" = "content") {
    messages = messages.map((m, i) => {
      if (i !== idx) {
        return m;
      }
      if (channel === "reasoning") {
        return { ...m, reasoning: (m.reasoning ?? "") + text };
      }
      return { ...m, content: m.content + text };
    });
  }
</script>

<TestModal
  bind:open
  {deployment}
  title="Test Chat Model"
  bind:apiKey
  apiKeyHint={'Paste an API key or click "Generate temporary key" to start chatting.'}
  onClose={handleClose}
  onOpen={handleOpen}
>
  {#snippet body()}
    <section class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="space-y-2">
        <Label class="text-sm font-semibold">Logging</Label>
        <label class="flex items-center gap-2 h-9 cursor-pointer select-none">
          <Checkbox bind:checked={storeCall} />
          <span class="text-sm">Store calls</span>
        </label>
      </div>
      <div class="space-y-2">
        <Label for="testApplication" class="text-sm font-semibold {storeCall ? '' : 'text-muted-foreground'}">
          Application
        </Label>
        <Select.Root type="single" bind:value={selectedApplicationId} disabled={!storeCall}>
          <Select.Trigger id="testApplication" class="w-full">
            {selectedApplication?.name ?? "None (default for key)"}
          </Select.Trigger>
          <Select.Content portalProps={{ disabled: true }}>
            <Select.Item value={NO_APPLICATION} label="None (default for key)" />
            {#each applications as app (app.id)}
              <Select.Item value={app.id} label={app.name} />
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
    </section>

    <section class="space-y-3">
      <div class="flex items-center justify-between">
        <Label class="text-sm font-semibold">Conversation</Label>
        <Button
          variant="ghost"
          size="sm"
          onclick={resetChat}
          disabled={messages.length === 0 && !sending}
          title="Clear conversation and abort any in-flight request"
        >
          <RotateCcw class="w-4 h-4" />
          Reset chat
        </Button>
      </div>
      <div
        bind:this={chatScroll}
        class="h-72 overflow-y-auto rounded-md border bg-background p-3 space-y-3"
      >
        {#if messages.length === 0}
          <p class="text-sm text-muted-foreground text-center py-12">
            Send a message to start chatting with the model.
          </p>
        {:else}
          {#each messages as msg, i (i)}
            <div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
              <div
                class="max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap {msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}"
              >
                <div class="text-[10px] uppercase tracking-wider opacity-70 mb-1">
                  {msg.role}
                </div>
                {#if msg.reasoning}
                  <div class="opacity-60 italic border-l-2 border-current/30 pl-2 mb-2 text-xs">
                    <div class="text-[9px] uppercase tracking-wider not-italic mb-1 opacity-80">Reasoning</div>
                    {msg.reasoning}
                  </div>
                {/if}
                {#if msg.content}
                  {msg.content}
                {:else if sending && i === messages.length - 1 && !msg.reasoning}
                  <Badge variant="secondary">thinking...</Badge>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </section>
  {/snippet}

  {#snippet footer()}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void handleSend();
      }}
      class="flex items-end gap-2"
    >
      <textarea
        bind:value={inputValue}
        bind:this={inputEl}
        placeholder="Type a message..."
        rows="2"
        disabled={sending}
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void handleSend();
          }
        }}
        class="flex-1 min-h-15 max-h-40 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
      ></textarea>
      <Button type="submit" disabled={!canSend}>
        <Send class="w-4 h-4" />
        Send
      </Button>
    </form>
  {/snippet}
</TestModal>
