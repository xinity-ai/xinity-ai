<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import * as Select from "$lib/components/ui/select";
  import * as Alert from "$lib/components/ui/alert";
  import { X, Send, Sparkles, Trash2, Eye, EyeOff, RotateCcw } from "@lucide/svelte";

  import { orpc } from "$lib/orpc/orpc-client";
  import type { ApplicationDto } from "$lib/orpc/dtos/application.dto";
  import type { DeploymentDefinition } from "./+page.server";
  import { toastState } from "$lib/state/toast.svelte";
  import { browserLogger } from "$lib/browserLogging";
  import { permissions } from "$lib/state/permissions.svelte";

  type ChatMessage = { role: "user" | "assistant"; content: string };

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

  const canCreateKey = $derived(permissions.can("apiKey", "create"));

  // API key. Either pasted by the user or pre-filled by "Generate temporary
  // key", in which case it is soft-deleted automatically on close.
  let apiKey = $state("");
  let showKey = $state(false);
  let temporaryKeyId = $state<string | null>(null);
  let creatingKey = $state(false);

  // Call settings
  let storeCall = $state(false);
  let selectedApplicationId = $state<string>(NO_APPLICATION);

  // Chat state
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

  // Re-scroll on every streamed chunk; depending on total content length
  // (rather than messages.length) so chunks that don't change message count
  // also fire the effect.
  const totalContentLen = $derived(messages.reduce((n, m) => n + m.content.length, 0));
  $effect(() => {
    void totalContentLen;
    if (chatScroll && messages.length > 0) {
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }
  });

  // Fresh-open reset. Triggers on every false->true transition so reopening
  // after an error always starts clean.
  let wasOpen = $state(false);
  $effect(() => {
    if (open && !wasOpen) {
      resetState();
      focusInput();
    }
    wasOpen = open;
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
    showKey = false;
    temporaryKeyId = null;
    storeCall = false;
    selectedApplicationId = NO_APPLICATION;
  }

  async function generateTemporaryKey() {
    if (!deployment || creatingKey) return;
    creatingKey = true;
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 12);
    const [error, result] = await orpc.apiKey.create({
      name: `Test - ${deployment.name} - ${stamp}`,
      enabled: true,
    });
    creatingKey = false;
    if (error) {
      browserLogger.warn({ error }, "Failed to create temporary test key");
      toastState.add("Failed to create temporary test key", "error");
      return;
    }
    apiKey = result.fullKey;
    showKey = true;
    // create() returns the specifier but not the id; resolve via list so we
    // can soft-delete the key on close.
    const [listError, list] = await orpc.apiKey.list({});
    if (!listError) {
      const created = list.find((k) => k.specifier === result.specifier);
      temporaryKeyId = created?.id ?? null;
    }
  }

  async function deleteTemporaryKey(silent = false) {
    if (!temporaryKeyId) return;
    const id = temporaryKeyId;
    temporaryKeyId = null;
    const [error] = await orpc.apiKey.delete({ id });
    if (error) {
      browserLogger.warn({ error, id }, "Failed to delete temporary test key");
      if (!silent) toastState.add("Failed to clean up temporary test key", "error");
    } else if (!silent) {
      toastState.add("Temporary test key deleted", "success");
    }
  }

  async function handleSend() {
    if (!canSend || !deployment) return;
    const userText = inputValue.trim();
    inputValue = "";
    // Append the user message + an empty assistant placeholder we stream into.
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

    // X-Application only matters when the call is being stored; skip it
    // otherwise so behavior matches the disabled selector.
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
      // The abort path (close/reset/new send) is intentional, not a real error.
      if (ctrl.signal.aborted) return;
      browserLogger.warn({ err }, "Test chat request failed");
      const detail = err instanceof Error ? err.message : "Network error";
      appendToAssistant(assistantIdx, `Error: ${detail}`);
    } finally {
      if (inflight === ctrl) inflight = null;
      sending = false;
      // Skip refocus on abort: the modal is closing or the chat was reset, and
      // grabbing focus mid-teardown would steal it from whatever is replacing us.
      if (!ctrl.signal.aborted) focusInput();
    }
  }

  async function consumeSseStream(body: ReadableStream<Uint8Array>, assistantIdx: number) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nlIdx).replace(/\r$/, "").trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            appendToAssistant(assistantIdx, delta);
          }
        } catch (err) {
          browserLogger.warn({ err, payload }, "Failed to parse SSE chunk");
        }
      }
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

  function appendToAssistant(idx: number, text: string) {
    messages = messages.map((m, i) =>
      i === idx ? { ...m, content: m.content + text } : m,
    );
  }

  async function handleClose() {
    inflight?.abort();
    if (temporaryKeyId) {
      await deleteTemporaryKey(true);
    }
    close();
  }
</script>

<Modal {open} onClose={handleClose} class="z-40">
  {#if open && deployment}
    <div class="bg-card rounded-xl shadow-2xl w-full max-w-3xl min-w-[min(48rem,90vw)] max-h-[90vh] flex flex-col">
      <header class="p-6 border-b flex justify-between items-center">
        <div>
          <h2 class="text-2xl font-semibold">Test Model</h2>
          <p class="text-sm text-muted-foreground mt-1">
            <span class="font-mono">{deployment.publicSpecifier}</span>
          </p>
        </div>
        <Button variant="ghost" size="icon" onclick={handleClose} aria-label="Close test modal">
          <X class="w-5 h-5" />
        </Button>
      </header>

      <main class="p-6 flex-1 overflow-y-auto space-y-5">
        <section class="space-y-2">
          <div class="flex items-center justify-between">
            <Label for="testApiKey" class="text-sm font-semibold">API Key</Label>
            {#if canCreateKey}
              <Button
                variant="ghost"
                size="sm"
                onclick={generateTemporaryKey}
                disabled={creatingKey}
              >
                <Sparkles class="w-4 h-4" />
                {creatingKey ? "Creating..." : "Generate temporary key"}
              </Button>
            {/if}
          </div>
          <div class="flex items-center gap-2">
            <Input
              id="testApiKey"
              type={showKey ? "text" : "password"}
              bind:value={apiKey}
              placeholder="Paste an API key (sk_...)"
              class="font-mono text-xs"
              autocomplete="off"
            />
            <Button
              variant="outline"
              size="icon"
              onclick={() => (showKey = !showKey)}
              title={showKey ? "Hide" : "Show"}
            >
              {#if showKey}
                <EyeOff class="w-4 h-4" />
              {:else}
                <Eye class="w-4 h-4" />
              {/if}
            </Button>
            {#if temporaryKeyId}
              <Button
                variant="outline"
                size="icon"
                onclick={() => deleteTemporaryKey(false)}
                title="Delete generated key now"
              >
                <Trash2 class="w-4 h-4" />
              </Button>
            {/if}
          </div>
          {#if temporaryKeyId}
            <p class="text-xs text-muted-foreground">
              Temporary key created. It will be deleted automatically when you close this dialog.
            </p>
          {/if}
        </section>

        <section class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="space-y-2">
            <Label class="text-sm font-semibold">Logging</Label>
            <label class="flex items-center gap-2 h-9 cursor-pointer select-none">
              <Checkbox
                checked={storeCall}
                onCheckedChange={(checked) => (storeCall = checked === true)}
              />
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
                    {#if msg.content}
                      {msg.content}
                    {:else if sending && i === messages.length - 1}
                      <Badge variant="secondary">thinking...</Badge>
                    {/if}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </section>

        {#if !apiKey.trim()}
          <Alert.Root>
            <Alert.Description class="text-xs">
              Paste an API key or click "Generate temporary key" to start chatting.
            </Alert.Description>
          </Alert.Root>
        {/if}
      </main>

      <footer class="p-4 border-t bg-muted/40 rounded-b-xl">
        <form
          onsubmit={(e) => { e.preventDefault(); void handleSend(); }}
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
      </footer>
    </div>
  {/if}
</Modal>
