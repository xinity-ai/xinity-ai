<script lang="ts">
  import type {
    ApiCall,
    ApiCallInputMessage,
    ApiCallResponse,
    InputExclusion,
  } from "common-db";
  import { onDestroy } from "svelte";
  import { getAPICallResponse, upsertApiCallResponse } from "./data.remote";
  import { messageContentToString, getRoleStyle, resolveImageSrc } from "./data.utils";
  import HighlightPopup from "./HighlightPopup.svelte";
  import RatingControls from "./RatingControls.svelte";
  import { browserLogger } from "$lib/browserLogging";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Download, Trash2, Pencil, Eye, EyeOff, Ban, X } from "@lucide/svelte";

  type Highlight = {
    start: number;
    end: number;
    type: boolean;
  };

  let {
    call = null,
    apiKeyNameMap,
    formatDate = (date: Date) => new Date(date).toLocaleString("de-AT"),
    onDelete = () => {},
    canDelete = false,
  } = $props<{
    call?: ApiCall | null;
    apiKeyNameMap: Map<string, string>;
    formatDate?: (date: Date) => string;
    onDelete?: (call: ApiCall) => void;
    canDelete?: boolean;
  }>();

  let activeCall = $state<ApiCall | null>(null);
  let currentRating = $state<ApiCallResponse | null>(null);
  let editedResponse = $state("");
  let lastSavedValue = $state("");
  let isEdited = $state(false);
  let responseTab = $state<"original" | "edit">("original");
  let editTabUnlocked = $state(false);

  let selectionPopup = $state({
    visible: false,
    x: 0,
    y: 0,
    text: "",
    startIndex: -1,
    endIndex: -1,
    token: 0,
  });
  let selectionPopupTimeout: ReturnType<typeof setTimeout> | null = null;

  let hoverPopup = $state({
    visible: false,
    x: 0,
    y: 0,
    highlightStart: -1,
    highlightEnd: -1,
    locked: false,
  });
  let hoverPopupTimeout: ReturnType<typeof setTimeout> | null = null;

  let inputExclusionPopup = $state({
    visible: false,
    x: 0,
    y: 0,
    messageIndex: -1,
    startIndex: -1,
    endIndex: -1,
    token: 0,
  });
  let inputExclusionPopupTimeout: ReturnType<typeof setTimeout> | null = null;

  let inputExclusionHoverPopup = $state({
    visible: false,
    x: 0,
    y: 0,
    messageIndex: -1,
    start: -1,
    end: -1,
    locked: false,
  });
  let inputExclusionHoverTimeout: ReturnType<typeof setTimeout> | null = null;
  let inputMouseDownPos = { x: 0, y: 0 };

  let saveTimeout: ReturnType<typeof setTimeout> | number | null = null;
  let editorRef: HTMLTextAreaElement = $state<HTMLTextAreaElement>(null!);
  let originalEditorRef: HTMLTextAreaElement = $state<HTMLTextAreaElement>(null!);
  let highlightOverlayRef: HTMLDivElement = $state<HTMLDivElement>(null!);
  let mouseDownPos = { x: 0, y: 0 };

  const ratingRequest = $derived(call ? getAPICallResponse(call.id) : null);

  // Effect 1: When call prop changes → save pending changes, initialize new call
  $effect(() => {
    if (call && call.id !== activeCall?.id) {
      saveResponseIfChanged();
      const cachedRating = ratingRequest?.current ?? null;
      initializeFromCall(
        call,
        cachedRating?.apiCallId === call.id ? cachedRating : null,
      );
      return;
    }
    if (!call && activeCall) {
      saveResponseIfChanged();
      resetEditorState();
    }
  });

  // Effect 2: When ratingRequest resolves → update local rating if newer
  $effect(() => {
    if (!activeCall) return;
    if (!ratingRequest || ratingRequest.error) {
      if (ratingRequest?.error) {
        browserLogger.warn(ratingRequest.error, "Problem during rating fetch");
      }
      return;
    }

    const nextRating = ratingRequest.current || null;
    if (
      !nextRating &&
      currentRating &&
      currentRating.apiCallId === activeCall.id
    ) {
      return;
    }
    if (
      nextRating &&
      currentRating &&
      nextRating.apiCallId === currentRating.apiCallId &&
      getUpdatedAt(nextRating) <= getUpdatedAt(currentRating)
    ) {
      return;
    }

    syncRatingFromProps(nextRating);
  });

  function getOutputMessageText(message?: ApiCallInputMessage | null) {
    if (!message) return "";
    return messageContentToString(message.content);
  }

  const originalResponseText = $derived(
    activeCall ? getOutputMessageText(activeCall.outputMessage) : "",
  );
  const outputToolCalls = $derived(activeCall?.outputMessage?.tool_calls ?? []);
  const outputStructuredJson = $derived.by(() => {
    const text = originalResponseText.trim();
    if (!text || !(text.startsWith("{") || text.startsWith("["))) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return null;
    }
  });
  const isModifiedFromOriginal = $derived(
    activeCall ? editedResponse !== originalResponseText : false,
  );
  const hasHighlights = $derived(
    (currentRating?.highlights?.length ?? 0) > 0,
  );
  const excludedMessages = $derived(currentRating?.excludedMessages ?? []);
  const inputExclusions = $derived(currentRating?.inputExclusions ?? []);
  const highlightedResponseHtml = $derived(renderHighlightedResponse());

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function deriveResponseText(
    nextCall: ApiCall,
    nextRating: ApiCallResponse | null,
  ) {
    return (
      nextRating?.outputEdit ?? getOutputMessageText(nextCall.outputMessage)
    );
  }

  function ensureRatingState(): ApiCallResponse {
    if (currentRating) return currentRating;
    if (!activeCall) {
      throw new Error("No active call to attach rating to");
    }

    const now = new Date();
    currentRating = {
      apiCallId: activeCall.id,
      userId: "placeholder",
      response: null,
      outputEdit: null,
      highlights: [],
      excludedMessages: [],
      inputExclusions: [],
      createdAt: now,
      updatedAt: now,
    };

    return currentRating;
  }

  function getUpdatedAt(value: ApiCallResponse) {
    if (value.updatedAt instanceof Date) return value.updatedAt.getTime();
    return new Date(value.updatedAt).getTime();
  }

  function initializeFromCall(
    nextCall: ApiCall,
    nextRating: ApiCallResponse | null,
  ) {
    activeCall = nextCall;
    currentRating = nextRating;
    const baseResponse = deriveResponseText(nextCall, nextRating);
    editedResponse = baseResponse;
    lastSavedValue = baseResponse;
    selectionPopup.text = "";
    selectionPopup.startIndex = -1;
    selectionPopup.endIndex = -1;
    selectionPopup.visible = false;
    clearInputExclusionPopup();
    hideInputExclusionHover();
    // If response was previously edited, unlock the edit tab and show it
    const hasExistingEdit = nextRating?.outputEdit != null;
    editTabUnlocked = hasExistingEdit;
    responseTab = hasExistingEdit ? "edit" : "original";
  }

  function resetEditorState() {
    activeCall = null;
    currentRating = null;
    editedResponse = "";
    lastSavedValue = "";
    selectionPopup.text = "";
    selectionPopup.startIndex = -1;
    selectionPopup.endIndex = -1;
    selectionPopup.visible = false;
    clearInputExclusionPopup();
    hideInputExclusionHover();
    responseTab = "original";
    editTabUnlocked = false;
  }

  function handleBlur() {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }

    saveResponseIfChanged();
  }

  function saveResponseIfChanged() {
    if (!activeCall) return;
    if (editedResponse === lastSavedValue) return;

    const ratingState = ensureRatingState();
    const payload = {
      outputEdit: editedResponse,
      response: isEdited ? null : ratingState.response,
    };

    upsertApiCallResponse({
      apiCallId: activeCall.id,
      payload,
    });
    applyRatingUpdate(payload, ratingState);
    lastSavedValue = editedResponse;
    isEdited = false;
  }

  function rateResponse(rating: boolean | null) {
    if (!activeCall) return;

    const newRating = currentRating?.response === rating ? null : rating;
    const ratingState = ensureRatingState();

    upsertApiCallResponse({
      apiCallId: activeCall.id,
      payload: { response: newRating },
    });
    applyRatingUpdate({ response: newRating }, ratingState);
  }

  function handleEditorInput() {
    if (!activeCall) return;
    isEdited = editedResponse !== lastSavedValue;

    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }
    saveTimeout = setTimeout(() => {
      saveResponseIfChanged();
    }, 30000);
  }

  function handleOriginalSelection(event: MouseEvent) {
    if (selectionPopupTimeout) {
      clearTimeout(selectionPopupTimeout);
      selectionPopupTimeout = null;
    }
    hideHoverPopup();

    // Ignore clicks (minimal mouse movement), only act on intentional drags
    const dx = event.clientX - mouseDownPos.x;
    const dy = event.clientY - mouseDownPos.y;
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
      clearSelectionState();
      return;
    }

    if (!originalEditorRef) {
      clearSelectionState();
      return;
    }

    const start = originalEditorRef.selectionStart;
    const end = originalEditorRef.selectionEnd;

    if (start === end) {
      clearSelectionState();
      return;
    }

    const selectedStr = originalResponseText.substring(start, end).trim();
    if (!selectedStr) {
      clearSelectionState();
      return;
    }

    selectionPopup.text = selectedStr;
    selectionPopup.startIndex = start;
    selectionPopup.endIndex = end;

    selectionPopup.x = event.clientX;
    selectionPopup.y = event.clientY - 35;

    const token = ++selectionPopup.token;
    selectionPopupTimeout = setTimeout(() => {
      if (token !== selectionPopup.token) return;
      if (
        selectionPopup.text &&
        selectionPopup.startIndex >= 0 &&
        selectionPopup.endIndex > selectionPopup.startIndex
      ) {
        selectionPopup.visible = true;
      }
    }, 700);
  }

  function applyHighlightFromPopup(type: "positive" | "negative") {
    if (
      !activeCall ||
      !selectionPopup.text ||
      selectionPopup.startIndex < 0 ||
      selectionPopup.endIndex < 0
    ) {
      return;
    }

    const rating = ensureRatingState();

    const newHighlight: Highlight = {
      start: selectionPopup.startIndex,
      end: selectionPopup.endIndex,
      type: type === "positive",
    };

    const existingHighlights = rating.highlights ?? [];
    const nonOverlappingHighlights = existingHighlights.filter(
      (h) => h.end <= newHighlight.start || h.start >= newHighlight.end,
    );

    const updatedHighlights = [...nonOverlappingHighlights, newHighlight];

    applyRatingUpdate({ highlights: updatedHighlights }, rating);
    upsertApiCallResponse({
      apiCallId: activeCall.id,
      payload: { highlights: updatedHighlights },
    });
    selectionPopup.visible = false;
  }

  function updateHighlightRange(
    start: number,
    end: number,
    type: "positive" | "negative" | "clear",
  ) {
    if (!activeCall) return;
    const ratingState = ensureRatingState();
    const existingHighlights = ratingState.highlights ?? [];
    const withoutTarget = existingHighlights.filter(
      (h) => !(h.start === start && h.end === end),
    );

    let updatedHighlights = withoutTarget;
    if (type !== "clear") {
      updatedHighlights = [
        ...withoutTarget.filter((h) => h.end <= start || h.start >= end),
        { start, end, type: type === "positive" },
      ];
    }

    applyRatingUpdate({ highlights: updatedHighlights }, ratingState);
    upsertApiCallResponse({
      apiCallId: activeCall.id,
      payload: { highlights: updatedHighlights },
    });
  }

  function hideHoverPopup() {
    if (hoverPopupTimeout) {
      clearTimeout(hoverPopupTimeout);
      hoverPopupTimeout = null;
    }
    hoverPopup.visible = false;
    hoverPopup.highlightStart = -1;
    hoverPopup.highlightEnd = -1;
  }

  function scheduleHideHoverPopup() {
    if (hoverPopupTimeout) clearTimeout(hoverPopupTimeout);
    if (hoverPopup.locked) return;
    hoverPopupTimeout = setTimeout(() => {
      if (!hoverPopup.locked) {
        hideHoverPopup();
      }
    }, 120);
  }

  function handleHighlightHover(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (
      !target.classList.contains("highlight-positive") &&
      !target.classList.contains("highlight-negative")
    ) {
      if (hoverPopup.visible) {
        scheduleHideHoverPopup();
      }
      return;
    }

    const start = parseInt(target.getAttribute("data-start") || "-1", 10);
    const end = parseInt(target.getAttribute("data-end") || "-1", 10);
    if (start < 0 || end < 0) return;

    const rect = target.getBoundingClientRect();
    hoverPopup.x = rect.left + rect.width / 2;
    hoverPopup.y = rect.top - 35;
    hoverPopup.highlightStart = start;
    hoverPopup.highlightEnd = end;
    hoverPopup.visible = true;
    selectionPopup.visible = false;
  }

  function renderHighlightedResponse(): string {
    const text = originalResponseText;
    if (
      !activeCall ||
      !currentRating?.highlights ||
      currentRating.highlights.length === 0
    ) {
      return escapeHtml(text);
    }

    const sortedHighlights = [...currentRating.highlights].sort(
      (a, b) => a.start - b.start,
    );

    let result = "";
    let lastIndex = 0;

    for (const highlight of sortedHighlights) {
      result += escapeHtml(
        text.substring(lastIndex, highlight.start),
      );

      const highlightedText = escapeHtml(
        text.substring(highlight.start, highlight.end),
      );
      const highlightClass = highlight.type ? "positive" : "negative";
      result += `<span class="highlight-${highlightClass}" data-start="${highlight.start}" data-end="${highlight.end}">${highlightedText}</span>`;

      lastIndex = highlight.end;
    }

    result += escapeHtml(text.substring(lastIndex));
    return result;
  }

  function applyRatingUpdate(
    payload: Partial<ApiCallResponse>,
    ratingState: ApiCallResponse = ensureRatingState(),
  ) {
    const now = new Date();
    const nextRating = { ...ratingState, ...payload, updatedAt: now };
    currentRating = nextRating;
    return nextRating;
  }

  function clearSelectionState() {
    if (selectionPopupTimeout) {
      clearTimeout(selectionPopupTimeout);
      selectionPopupTimeout = null;
    }
    selectionPopup.token += 1;
    selectionPopup.visible = false;
    selectionPopup.text = "";
    selectionPopup.startIndex = -1;
    selectionPopup.endIndex = -1;
  }

  // --- Input exclusion functions ---

  function toggleMessageExclusion(messageIndex: number) {
    if (!activeCall) return;
    const rating = ensureRatingState();
    const current = rating.excludedMessages ?? [];
    const updated = current.includes(messageIndex)
      ? current.filter((i) => i !== messageIndex)
      : [...current, messageIndex];
    applyRatingUpdate({ excludedMessages: updated }, rating);
    upsertApiCallResponse({
      apiCallId: activeCall.id,
      payload: { excludedMessages: updated },
    });
  }

  function handleInputSelection(event: MouseEvent, messageIndex: number) {
    if (inputExclusionPopupTimeout) {
      clearTimeout(inputExclusionPopupTimeout);
      inputExclusionPopupTimeout = null;
    }
    hideInputExclusionHover();

    // Ignore clicks (minimal mouse movement), only act on intentional drags
    const dx = event.clientX - inputMouseDownPos.x;
    const dy = event.clientY - inputMouseDownPos.y;
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
      clearInputExclusionPopup();
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      clearInputExclusionPopup();
      return;
    }

    const range = sel.getRangeAt(0);
    const container = event.currentTarget as HTMLElement;

    // Calculate character offset relative to the container's text content
    const preRange = document.createRange();
    preRange.selectNodeContents(container);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const end = start + range.toString().length;

    if (end <= start) {
      clearInputExclusionPopup();
      return;
    }

    inputExclusionPopup.messageIndex = messageIndex;
    inputExclusionPopup.startIndex = start;
    inputExclusionPopup.endIndex = end;
    inputExclusionPopup.x = event.clientX;
    inputExclusionPopup.y = event.clientY - 35;

    const token = ++inputExclusionPopup.token;
    inputExclusionPopupTimeout = setTimeout(() => {
      if (token !== inputExclusionPopup.token) return;
      inputExclusionPopup.visible = true;
    }, 700);
  }

  function applyInputExclusion() {
    if (!activeCall || inputExclusionPopup.messageIndex < 0) return;
    const rating = ensureRatingState();
    const existing = rating.inputExclusions ?? [];

    const newExclusion: InputExclusion = {
      messageIndex: inputExclusionPopup.messageIndex,
      start: inputExclusionPopup.startIndex,
      end: inputExclusionPopup.endIndex,
    };

    // Remove overlapping exclusions for the same message
    const nonOverlapping = existing.filter(
      (e) =>
        e.messageIndex !== newExclusion.messageIndex ||
        e.end <= newExclusion.start ||
        e.start >= newExclusion.end,
    );
    const updated = [...nonOverlapping, newExclusion];

    applyRatingUpdate({ inputExclusions: updated }, rating);
    upsertApiCallResponse({
      apiCallId: activeCall.id,
      payload: { inputExclusions: updated },
    });
    clearInputExclusionPopup();
    window.getSelection()?.removeAllRanges();
  }

  function clearInputExclusion(
    messageIndex: number,
    start: number,
    end: number,
  ) {
    if (!activeCall) return;
    const rating = ensureRatingState();
    const existing = rating.inputExclusions ?? [];
    const updated = existing.filter(
      (e) =>
        !(
          e.messageIndex === messageIndex &&
          e.start === start &&
          e.end === end
        ),
    );
    applyRatingUpdate({ inputExclusions: updated }, rating);
    upsertApiCallResponse({
      apiCallId: activeCall.id,
      payload: { inputExclusions: updated },
    });
  }

  function clearInputExclusionPopup() {
    if (inputExclusionPopupTimeout) {
      clearTimeout(inputExclusionPopupTimeout);
      inputExclusionPopupTimeout = null;
    }
    inputExclusionPopup.visible = false;
    inputExclusionPopup.token += 1;
  }

  function renderExcludedInputHtml(
    messageIndex: number,
    text: string,
  ): string {
    const exclusions = inputExclusions
      .filter((e) => e.messageIndex === messageIndex)
      .sort((a, b) => a.start - b.start);

    if (exclusions.length === 0) return escapeHtml(text);

    let result = "";
    let lastIndex = 0;
    for (const ex of exclusions) {
      result += escapeHtml(text.substring(lastIndex, ex.start));
      const exText = escapeHtml(text.substring(ex.start, ex.end));
      result += `<span class="input-exclusion" data-msg="${messageIndex}" data-start="${ex.start}" data-end="${ex.end}">${exText}</span>`;
      lastIndex = ex.end;
    }
    result += escapeHtml(text.substring(lastIndex));
    return result;
  }

  function handleInputExclusionHover(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("input-exclusion")) {
      if (inputExclusionHoverPopup.visible)
        scheduleHideInputExclusionHover();
      return;
    }
    const msgIdx = parseInt(
      target.getAttribute("data-msg") || "-1",
      10,
    );
    const start = parseInt(
      target.getAttribute("data-start") || "-1",
      10,
    );
    const end = parseInt(
      target.getAttribute("data-end") || "-1",
      10,
    );
    if (msgIdx < 0 || start < 0 || end < 0) return;

    const rect = target.getBoundingClientRect();
    inputExclusionHoverPopup.x = rect.left + rect.width / 2;
    inputExclusionHoverPopup.y = rect.top - 35;
    inputExclusionHoverPopup.messageIndex = msgIdx;
    inputExclusionHoverPopup.start = start;
    inputExclusionHoverPopup.end = end;
    inputExclusionHoverPopup.visible = true;
    inputExclusionPopup.visible = false;
  }

  function scheduleHideInputExclusionHover() {
    if (inputExclusionHoverTimeout) clearTimeout(inputExclusionHoverTimeout);
    if (inputExclusionHoverPopup.locked) return;
    inputExclusionHoverTimeout = setTimeout(() => {
      if (!inputExclusionHoverPopup.locked) {
        hideInputExclusionHover();
      }
    }, 120);
  }

  function hideInputExclusionHover() {
    if (inputExclusionHoverTimeout) {
      clearTimeout(inputExclusionHoverTimeout);
      inputExclusionHoverTimeout = null;
    }
    inputExclusionHoverPopup.visible = false;
    inputExclusionHoverPopup.messageIndex = -1;
    inputExclusionHoverPopup.start = -1;
    inputExclusionHoverPopup.end = -1;
  }

  function syncRatingFromProps(
    nextRating: ApiCallResponse | null,
    callContext: ApiCall | null = activeCall,
  ) {
    currentRating = nextRating ? { ...nextRating } : null;

    if (!callContext) return;

    if (!isEdited) {
      const baseResponse = deriveResponseText(callContext, nextRating);
      editedResponse = baseResponse;
      lastSavedValue = baseResponse;
    }
  }

  function formatDuration(durationMs: number) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  // Use the server-side export endpoint so xinity-media:// image refs
  // are resolved to data URIs in the downloaded file.
  const downloadUrl = $derived(
    activeCall ? `/data/export/${activeCall.id}` : null,
  );

  const downloadFilename = $derived(
    activeCall ? `call-${activeCall.id}.json` : "",
  );

  onDestroy(() => {
    if (saveTimeout) clearTimeout(saveTimeout);
    if (selectionPopupTimeout) clearTimeout(selectionPopupTimeout);
    if (hoverPopupTimeout) clearTimeout(hoverPopupTimeout);
    if (inputExclusionPopupTimeout) clearTimeout(inputExclusionPopupTimeout);
    if (inputExclusionHoverTimeout) clearTimeout(inputExclusionHoverTimeout);
    saveResponseIfChanged();
  });
</script>

{#if activeCall}
  <Card.Root>
    <Card.Header class="border-b bg-muted/50">
      <div class="flex items-center justify-between">
        <Card.Title class="text-base">Call Details</Card.Title>
        <Badge variant="secondary" class="font-mono text-xs">
          ID: {activeCall.id}
        </Badge>
      </div>
    </Card.Header>
    <Card.Content class="p-6 compact:p-3">
      <div class="grid grid-cols-1 gap-6 compact:gap-3 md:grid-cols-2">
        <div>
          <h3 class="mb-2 text-lg compact:mb-1 compact:text-base font-medium">Input Messages</h3>
          {#if !activeCall.inputMessages || activeCall.inputMessages.length === 0}
            <p class="text-muted-foreground text-sm">No input available</p>
          {:else}
            <div class="flex flex-col gap-3 compact:gap-2">
              {#each activeCall.inputMessages as msg, idx (idx)}
                {@const style = getRoleStyle(msg.role)}
                {@const isExcluded = excludedMessages.includes(idx)}
                {@const hasExclusions = inputExclusions.some((e) => e.messageIndex === idx)}
                <div class="relative rounded-md border-l-3 {style.borderColor} {style.bgColor} p-3 compact:p-2">
                  <div class="transition-opacity {isExcluded ? 'msg-excluded' : ''}">
                  <div class="flex items-center gap-2 mb-2 compact:mb-1">
                    <span class="inline-block rounded-full px-2 py-0.5 text-xs font-medium {style.badgeColor}">
                      {style.label}
                    </span>
                    {#if msg.tool_call_id}
                      <span class="text-[10px] font-mono text-muted-foreground" title="Tool call ID">{msg.tool_call_id}</span>
                    {/if}
                  </div>
                  {#if typeof msg.content === "string"}
                    {#if hasExclusions}
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <div
                        class="text-sm leading-relaxed whitespace-pre-wrap input-selectable"
                        onmouseup={(e) => handleInputSelection(e, idx)}
                        onmousedown={(e) => { inputMouseDownPos = { x: e.clientX, y: e.clientY }; clearInputExclusionPopup(); }}
                        onmousemove={handleInputExclusionHover}
                      >{@html renderExcludedInputHtml(idx, msg.content)}</div>
                    {:else}
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <div
                        class="text-sm leading-relaxed whitespace-pre-wrap input-selectable"
                        onmouseup={(e) => handleInputSelection(e, idx)}
                        onmousedown={(e) => { inputMouseDownPos = { x: e.clientX, y: e.clientY }; clearInputExclusionPopup(); }}
                      >{msg.content}</div>
                    {/if}
                  {:else if Array.isArray(msg.content)}
                    {#each msg.content as piece, pieceIdx (pieceIdx)}
                      {#if piece.type === "text"}
                        {#if hasExclusions}
                          <!-- svelte-ignore a11y_no_static_element_interactions -->
                          <div
                            class="text-sm leading-relaxed whitespace-pre-wrap input-selectable"
                            onmouseup={(e) => handleInputSelection(e, idx)}
                            onmousedown={(e) => { inputMouseDownPos = { x: e.clientX, y: e.clientY }; clearInputExclusionPopup(); }}
                            onmousemove={handleInputExclusionHover}
                          >{@html renderExcludedInputHtml(idx, piece.text)}</div>
                        {:else}
                          <!-- svelte-ignore a11y_no_static_element_interactions -->
                          <div
                            class="text-sm leading-relaxed whitespace-pre-wrap input-selectable"
                            onmouseup={(e) => handleInputSelection(e, idx)}
                            onmousedown={(e) => { inputMouseDownPos = { x: e.clientX, y: e.clientY }; clearInputExclusionPopup(); }}
                          >{piece.text}</div>
                        {/if}
                      {:else if piece.type === "image_url"}
                        <img
                          src={resolveImageSrc(piece.image_url.url)}
                          alt="attachment"
                          class="max-w-xs max-h-64 rounded mt-1 object-contain"
                          loading="lazy"
                        />
                      {:else}
                        <pre class="whitespace-pre-wrap text-xs font-mono bg-muted/50 p-2 rounded mt-1">{JSON.stringify(piece, null, 2)}</pre>
                      {/if}
                    {/each}
                  {/if}
                  {#if msg.tool_calls?.length}
                    {#each msg.tool_calls as tc (tc.id)}
                      <div class="mt-2 rounded border border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/20 p-2 text-xs font-mono">
                        <div class="flex items-center gap-2">
                          <span class="font-semibold text-purple-600 dark:text-purple-400">{tc.function.name}()</span>
                          <span class="text-[10px] text-muted-foreground">{tc.id}</span>
                        </div>
                        <pre class="mt-1 whitespace-pre-wrap text-muted-foreground">{tc.function.arguments}</pre>
                      </div>
                    {/each}
                  {/if}
                  </div>
                  <button
                    type="button"
                    class="msg-exclude-btn absolute top-2 right-2 p-1 rounded cursor-pointer hover:bg-muted/50 transition-colors {isExcluded ? 'text-red-500' : 'text-muted-foreground hover:text-foreground'}"
                    title={isExcluded ? "Include in training" : "Exclude from training"}
                    onclick={() => toggleMessageExclusion(idx)}
                  >
                    {#if isExcluded}
                      <EyeOff class="w-4 h-4" />
                    {:else}
                      <Eye class="w-4 h-4" />
                    {/if}
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          {#if inputExclusionPopup.visible}
            <div
              class="highlight-popup"
              role="group"
              style="left: {inputExclusionPopup.x}px; top: {inputExclusionPopup.y}px;"
            >
              <button
                type="button"
                class="highlight-popup-btn exclusion-btn"
                title="Exclude from training"
                onclick={applyInputExclusion}
              >
                <Ban class="w-5 h-5" />
              </button>
            </div>
          {/if}

          {#if inputExclusionHoverPopup.visible}
            <div
              class="highlight-popup"
              role="group"
              style="left: {inputExclusionHoverPopup.x}px; top: {inputExclusionHoverPopup.y}px;"
              onmouseenter={() => { inputExclusionHoverPopup.locked = true; }}
              onmouseleave={() => { inputExclusionHoverPopup.locked = false; scheduleHideInputExclusionHover(); }}
            >
              <button
                type="button"
                class="highlight-popup-btn neutral-btn"
                title="Remove exclusion"
                onclick={() => {
                  clearInputExclusion(
                    inputExclusionHoverPopup.messageIndex,
                    inputExclusionHoverPopup.start,
                    inputExclusionHoverPopup.end,
                  );
                  hideInputExclusionHover();
                }}
              >
                <X class="w-5 h-5" />
              </button>
            </div>
          {/if}
        </div>

        <div>
          <div class="flex items-center justify-between mb-2 compact:mb-1">
            <div class="flex items-center gap-1">
              <button
                class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors {responseTab === 'original' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}"
                onclick={() => (responseTab = "original")}
              >
                <Eye class="w-3.5 h-3.5" />
                Original
              </button>
              {#if editTabUnlocked}
                <button
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors {responseTab === 'edit' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}"
                  onclick={() => (responseTab = "edit")}
                >
                  <Pencil class="w-3.5 h-3.5" />
                  Edit
                  {#if isModifiedFromOriginal}
                    <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                  {/if}
                </button>
              {/if}
            </div>
            {#if !editTabUnlocked}
              <Button
                variant="outline"
                size="sm"
                onclick={() => { editTabUnlocked = true; responseTab = "edit"; }}
              >
                <Pencil class="w-3.5 h-3.5" />
                Edit Response
              </Button>
            {:else if responseTab === "edit"}
              <span class="text-xs {isModifiedFromOriginal ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}">
                {isModifiedFromOriginal ? "Edited from original" : "Original text"}
              </span>
            {/if}
          </div>

          {#if responseTab === "original"}
            {#if outputStructuredJson}
              <div class="rounded border bg-muted/30 p-3 compact:p-2">
                <Badge variant="outline" class="mb-2 text-[10px]">Structured Output</Badge>
                <pre class="whitespace-pre-wrap text-xs font-mono text-foreground">{outputStructuredJson}</pre>
              </div>
            {:else if originalResponseText}
            <div class="relative">
              <textarea
                readonly
                bind:this={originalEditorRef}
                value={originalResponseText}
                class="unified-editor"
                style="border-left-color: transparent; resize: none;{hasHighlights ? ' color: transparent; caret-color: transparent;' : ''}"
                onmouseup={handleOriginalSelection}
                onmousedown={(e) => {
                  mouseDownPos = { x: e.clientX, y: e.clientY };
                  clearSelectionState();
                  hideHoverPopup();
                }}
                onscroll={() => { if (highlightOverlayRef) highlightOverlayRef.scrollTop = originalEditorRef.scrollTop; }}
              ></textarea>

              {#if hasHighlights}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  bind:this={highlightOverlayRef}
                  class="highlight-overlay"
                  onmousemove={handleHighlightHover}
                >
                  <p class="whitespace-pre-wrap m-0">{@html highlightedResponseHtml}</p>
                </div>
              {/if}
            </div>

            <HighlightPopup
              visible={selectionPopup.visible && !!selectionPopup.text}
              x={selectionPopup.x}
              y={selectionPopup.y}
              onSelect={applyHighlightFromPopup}
            />

            <HighlightPopup
              visible={hoverPopup.visible}
              x={hoverPopup.x}
              y={hoverPopup.y}
              onSelect={(type) => {
                if (hoverPopup.highlightStart < 0 || hoverPopup.highlightEnd < 0) return;
                updateHighlightRange(hoverPopup.highlightStart, hoverPopup.highlightEnd, type);
                hideHoverPopup();
              }}
              showClear={true}
              onClear={() => {
                if (hoverPopup.highlightStart < 0 || hoverPopup.highlightEnd < 0) return;
                updateHighlightRange(
                  hoverPopup.highlightStart,
                  hoverPopup.highlightEnd,
                  "clear",
                );
                hideHoverPopup();
              }}
              onMouseEnter={() => {
                hoverPopup.locked = true;
              }}
              onMouseLeave={() => {
                hoverPopup.locked = false;
                scheduleHideHoverPopup();
              }}
            />
            {/if}
            {#if outputToolCalls.length > 0}
              <div class="mt-2 flex flex-col gap-2">
                {#each outputToolCalls as tc (tc.id)}
                  <div class="rounded border border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/20 p-2 text-xs font-mono">
                    <div class="flex items-center gap-2">
                      <span class="font-semibold text-purple-600 dark:text-purple-400">{tc.function.name}()</span>
                      <span class="text-[10px] text-muted-foreground">{tc.id}</span>
                    </div>
                    <pre class="mt-1 whitespace-pre-wrap text-muted-foreground">{tc.function.arguments}</pre>
                  </div>
                {/each}
              </div>
            {/if}
            {#if !originalResponseText && outputToolCalls.length === 0}
              <p class="text-muted-foreground text-sm">No response content</p>
            {/if}
          {:else}
            <textarea
              bind:this={editorRef}
              bind:value={editedResponse}
              class="unified-editor"
              aria-label="LLM Response editor"
              oninput={handleEditorInput}
              onblur={handleBlur}
            ></textarea>
          {/if}

          <RatingControls
            value={currentRating?.response ?? null}
            isEdited={isEdited}
            onRate={rateResponse}
          />
        </div>
      </div>

      <div class="mt-6 compact:mt-3">
        <h3 class="mb-2 text-lg compact:mb-1 compact:text-base font-medium">Call Details</h3>
        <div
          class="flex flex-wrap items-center justify-between p-4 mb-4 compact:p-2 compact:mb-2 rounded bg-muted/50"
        >
          <div class="min-w-35 flex-1">
            <p class="text-xs text-muted-foreground">Created</p>
            <p class="font-medium">
              {formatDate(activeCall.createdAt)}
            </p>
          </div>
          <div class="min-w-20 flex-1">
            <p class="text-xs text-muted-foreground">Model</p>
            <p class="font-medium">{activeCall.model}</p>
          </div>
          <div class="min-w-20 flex-1">
            <p class="text-xs text-muted-foreground">Specified Model</p>
            <p class="font-medium">
              {activeCall.specifiedModel}
            </p>
          </div>
          <div class="min-w-30 flex-1">
            <p class="text-xs text-muted-foreground">API Key</p>
            <p class="font-medium">
              {apiKeyNameMap.get(activeCall.apiKeyId) || "Unknown Key"}
            </p>
          </div>
          <div class="min-w-20 flex-1">
            <p class="text-xs text-muted-foreground">Duration</p>
            <p class="font-medium">{formatDuration(activeCall.duration)}</p>
          </div>
        </div>
      </div>

      {#if activeCall.metadata && Object.keys(activeCall.metadata).length > 0}
        <div class="mt-4 compact:mt-2">
          <h3 class="mb-2 text-lg compact:mb-1 compact:text-base font-medium">Metadata</h3>
          <div class="flex flex-wrap gap-2 p-4 compact:p-2 rounded bg-muted/50">
            {#each Object.entries(activeCall.metadata) as [key, value]}
              <Badge variant="outline" class="font-mono text-xs">
                {key}: {typeof value === "object" ? JSON.stringify(value) : String(value)}
              </Badge>
            {/each}
          </div>
        </div>
      {/if}

      <div class="flex justify-end gap-2 mt-6 compact:mt-3">
        {#if downloadUrl}
          <Button variant="outline" href={downloadUrl} download={downloadFilename}>
            <Download class="w-4 h-4" />
            Download JSON
          </Button>
        {/if}
        {#if canDelete}
          <Button
            variant="destructive"
            onclick={() => activeCall && onDelete?.(activeCall)}
          >
            <Trash2 class="w-4 h-4" />
            Delete Call
          </Button>
        {/if}
      </div>
    </Card.Content>
  </Card.Root>
{:else}
  <Card.Root class="flex items-center justify-center h-full p-8">
    <p class="text-muted-foreground">Select an API call to view details</p>
  </Card.Root>
{/if}
