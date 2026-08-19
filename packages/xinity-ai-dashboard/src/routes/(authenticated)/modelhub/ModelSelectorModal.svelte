<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import type { Engine, IncompatibilityReason, ModelType, ModelWithSpecifier, NodeCapability } from "xinity-infoserver";
  import { EngineEnum, blockedVersionNotes, explainClusterIncompatibility } from "xinity-infoserver";
  import { modelCatalog } from "$lib/state/model-catalog.svelte";
  import { formatGb } from "$lib/util";
  import { groupModelVariants, groupIncompatibility, type ModelGroup } from "./model-groups";
  import { SvelteSet } from "svelte/reactivity";

  // shadcn components
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Badge } from "$lib/components/ui/badge";
  import ModelChoiceCard from "./ModelChoiceCard.svelte";

  // Icons
  import { X, Search, Info, HardDrive, Eye, EyeOff, Plus, Loader2, AlertCircle,
    LayoutGrid, MessageSquare, Boxes, ArrowUpDown, Mic } from "@lucide/svelte";
  // Icons for the not-yet-available model types (see MODEL_TYPES below):
  // import { Image as ImageIcon, AudioLines } from "@lucide/svelte";

  /** Minimum number of filtered results before auto-loading the next page. */
  const MIN_RESULTS_THRESHOLD = 10;

  const MODEL_REQUEST_URL = "https://github.com/xinity-ai/xinity-ai/issues/new?template=model_request.yml";

  const MODEL_TYPES = [
    { value: "all", label: "All", icon: LayoutGrid },
    { value: "chat", label: "Chat", icon: MessageSquare },
    { value: "embedding", label: "Embedding", icon: Boxes },
    { value: "rerank", label: "Rerank", icon: ArrowUpDown },
    { value: "transcription", label: "Transcription", icon: Mic },
    // { value: "image", label: "Image", icon: ImageIcon },
    // { value: "tts", label: "Text to Speech", icon: AudioLines },
  ] as const;

  const ENGINE_LABELS: Record<Engine, string> = { vllm: "vLLM", ollama: "Ollama" };
  const ENGINE_MODEL_TYPES: Record<Engine, readonly ModelType[]> = {
    vllm: ["chat", "embedding", "rerank", "transcription"],
    ollama: ["chat", "embedding"],
  };

  const ENGINE_FILTERS = [
    { value: "all" as const, label: "All" },
    ...EngineEnum.options.map(engine => ({ value: engine, label: ENGINE_LABELS[engine] })),
  ];

  // --- Props ---
  let {
    open = $bindable(false),
    onSelect,
    onClose,
    maxNodeFreeCapacity = Infinity,
    nodeCapabilities = [],
  }: {
    open: boolean;
    onSelect: (model: ModelWithSpecifier) => void;
    onClose: () => void;
    maxNodeFreeCapacity?: number;
    nodeCapabilities?: NodeCapability[];
  } = $props();

  // --- Filter State ---
  let searchTerm = $state("");
  let selectedEngine = $state<Engine | "all">("all");
  let selectedType = $state<(typeof MODEL_TYPES)[number]["value"]>("all");
  let showUnlisted = $state(false);
  // A plain Set is not reactive under $state, so mutating one updates nothing.
  const selectedTags = new SvelteSet<string>();
  let pickingFrom = $state<ModelGroup | null>(null);
  let sentinel = $state<HTMLElement | null>(null);

  // Trigger initial load when modal opens
  $effect(() => {
    if (open && !modelCatalog.initialLoaded && !modelCatalog.isLoading) {
      modelCatalog.loadMore();
    }
  });

  // Auto-load more when filtered results are sparse.
  // Stops immediately once hasMore is false; no further requests regardless of filter.
  $effect(() => {
    if (!open || !modelCatalog.initialLoaded || modelCatalog.isLoading || !modelCatalog.hasMore) return;
    searchTerm; selectedEngine; selectedType; selectedTags; showUnlisted;
    if (variantGroups.length < MIN_RESULTS_THRESHOLD) {
      modelCatalog.loadMore();
    }
  });

  // Infinite scroll via sentinel element
  $effect(() => {
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      () => { if (modelCatalog.hasMore && !modelCatalog.isLoading) modelCatalog.loadMore(); },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  // --- Derived State ---
  const totalFreeCapacity = $derived(nodeCapabilities.reduce((sum, n) => sum + n.free, 0));

  const allTags = $derived(
    Array.from(new Set(modelCatalog.models.flatMap((m) => m.tags))).sort(),
  );

  // Insertion order preserved; no re-sort prevents layout shifts when new pages arrive
  const filteredModels = $derived(
    modelCatalog.models.filter((m) => {
      const searchLower = searchTerm.toLowerCase();
      const matchesSearch =
        !searchLower ||
        m.name.toLowerCase().includes(searchLower) ||
        m.description.toLowerCase().includes(searchLower) ||
        m.publicSpecifier.toLowerCase().includes(searchLower) ||
        (m.family && m.family.toLowerCase().includes(searchLower));

      const matchesEngine = selectedEngine === "all" || m.engine === selectedEngine;

      const matchesType = selectedType === "all" || m.type === selectedType;

      const matchesTags =
        selectedTags.size === 0 ||
        Array.from(selectedTags).every((t) => m.tags.includes(t as typeof m.tags[number]));

      const isVisible = !m.unlisted || showUnlisted || searchLower === m.publicSpecifier.toLowerCase();

      return isVisible && matchesSearch && matchesEngine && matchesType && matchesTags;
    }),
  );

  const unlistedCount = $derived(modelCatalog.models.filter(m => m.unlisted).length);

  const variantGroups = $derived(groupModelVariants(filteredModels));

  const groupedModels = $derived(
    variantGroups.reduce(
      (acc, group) => {
        const family = group.leader.family || "Other";
        if (!acc[family]) acc[family] = [];
        acc[family].push(group);
        return acc;
      },
      {} as Record<string, ModelGroup[]>,
    ),
  );

  const sortedFamilies = $derived(Object.keys(groupedModels).sort());

  // --- Functions ---
  function unavailableForEngine(type: (typeof MODEL_TYPES)[number]["value"]): string | undefined {
    if (selectedEngine === "all" || type === "all") {
      return undefined;
    }
    if (ENGINE_MODEL_TYPES[selectedEngine].includes(type)) {
      return undefined;
    }
    return `${ENGINE_LABELS[selectedEngine]} does not serve ${type} models`;
  }

  function selectEngine(engine: Engine | "all") {
    selectedEngine = engine;
    if (unavailableForEngine(selectedType)) {
      selectedType = "all";
    }
  }

  function toggleTag(tag: string) {
    if (selectedTags.has(tag)) {
      selectedTags.delete(tag);
    } else {
      selectedTags.add(tag);
    }
  }

  function chooseFromGroup(group: ModelGroup) {
    if (group.variants.length > 1) {
      pickingFrom = group;
      return;
    }
    handleSelect(group.leader);
  }

  function undeployableReason(model: ModelWithSpecifier): IncompatibilityReason | null {
    // Without a cluster snapshot the only thing knowable is whether it could ever fit.
    if (nodeCapabilities.length === 0) {
      return model.sizing.weightGb + model.sizing.minKvCacheGb > maxNodeFreeCapacity ? "insufficient_capacity" : null;
    }
    return explainClusterIncompatibility(nodeCapabilities, model);
  }

  function blockedReleaseNote(model: ModelWithSpecifier): string | undefined {
    const notes = blockedVersionNotes(nodeCapabilities, model);
    return notes.length > 0 ? notes.join(" ") : undefined;
  }

  function handleSelect(model: ModelWithSpecifier) {
    pickingFrom = null;
    onSelect(model);
    onClose();
  }
</script>

<Modal {open} {onClose} class="z-50">
  <div class="bg-card rounded-xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">
    <!-- Header -->
    <header class="p-5 border-b flex justify-between items-center bg-muted/50">
      <div>
        <h2 class="text-xl font-bold">Select Model</h2>
        <p class="text-sm text-muted-foreground">
          {#if modelCatalog.initialLoaded}
            {modelCatalog.models.length} of {modelCatalog.totalCount} models loaded
          {:else}
            Choose a model for your deployment
          {/if}
        </p>
      </div>
      <div class="flex items-center gap-1">
        <a
          href={MODEL_REQUEST_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-border text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors"
          title="Missing a model? Open a request on GitHub"
        >
          <Plus class="w-3.5 h-3.5" />
          Request a model
        </a>
        <Button variant="ghost" size="icon" onclick={onClose} aria-label="Close modal">
          <X class="w-5 h-5" />
        </Button>
      </div>
    </header>

    <!-- Controls -->
    <div class="p-5 border-b bg-card space-y-4">
      <div class="relative">
        <Input
          type="text"
          placeholder="Search by name, description, or ID..."
          bind:value={searchTerm}
          class="pr-10"
        />
        <div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-muted-foreground">
          <Search class="w-4 h-4" />
        </div>
      </div>

      <div class="flex flex-wrap gap-2 items-center">
        <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mr-1">Engine:</span>
        {#each ENGINE_FILTERS as e}
          <button
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors duration-200 {selectedEngine === e.value ? 'bg-primary text-primary-foreground border-primary shadow-sm' : 'bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground'}"
            onclick={() => selectEngine(e.value)}
          >
            {e.label}
          </button>
        {/each}

        {#if unlistedCount > 0}
          <button
            class="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors duration-200 {showUnlisted ? 'bg-primary/10 text-primary border-primary/20' : 'bg-background text-muted-foreground border-border hover:border-primary/50'}"
            title={showUnlisted ? "Hide unlisted models again" : "Show models that are outdated or not recommended"}
            onclick={() => (showUnlisted = !showUnlisted)}
          >
            {#if showUnlisted}
              <Eye class="w-3 h-3" />
              Showing {unlistedCount} unlisted
            {:else}
              <EyeOff class="w-3 h-3" />
              {unlistedCount} unlisted
            {/if}
          </button>
        {/if}
      </div>

      <div class="flex flex-wrap gap-2 items-center">
        <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mr-1">Type:</span>
        {#each MODEL_TYPES as t}
          {@const unavailable = unavailableForEngine(t.value)}
          <button
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-border {selectedType === t.value ? 'bg-primary text-primary-foreground border-primary shadow-sm' : 'bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground'}"
            disabled={Boolean(unavailable)}
            title={unavailable}
            onclick={() => (selectedType = t.value)}
          >
            <t.icon class="w-3.5 h-3.5" />
            {t.label}
          </button>
        {/each}
      </div>

      {#if allTags.length > 0}
        <div class="flex flex-wrap gap-2 items-center">
          <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mr-1">Tags:</span>
          {#each allTags as tag}
            <button
              class="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors duration-200 {selectedTags.has(tag) ? 'bg-primary/10 text-primary border-primary/20' : 'bg-background text-muted-foreground border-border hover:border-primary/50'}"
              onclick={() => toggleTag(tag)}
            >
              {tag}
            </button>
          {/each}
        </div>
      {/if}

    </div>

    <!-- Capacity Info -->
    {#if maxNodeFreeCapacity !== Infinity}
      <div class="px-5 py-3 border-b bg-muted/30 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <div class="flex items-center gap-2">
          <HardDrive class="w-4 h-4 text-muted-foreground shrink-0" />
          <span class="text-muted-foreground">Largest node free:</span>
          <span class="font-semibold">{formatGb(maxNodeFreeCapacity)}</span>
        </div>
        {#if nodeCapabilities.length > 0}
          <div class="flex items-center gap-2">
            <span class="text-muted-foreground">Total free:</span>
            <span class="font-semibold">{formatGb(totalFreeCapacity)}</span>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Model List -->
    <main class="grow overflow-y-auto p-5 bg-muted/30">
      {#if modelCatalog.loadError && !modelCatalog.initialLoaded}
        <div class="flex flex-col items-center justify-center h-64 text-muted-foreground">
          <AlertCircle class="w-12 h-12 mb-4 text-destructive opacity-70" />
          <p class="text-lg font-medium text-destructive">Failed to load models</p>
          <p class="text-sm mt-1">{modelCatalog.loadError}</p>
          <Button variant="outline" class="mt-4" onclick={() => modelCatalog.retry()}>Retry</Button>
        </div>
      {:else if !modelCatalog.initialLoaded}
        <div class="flex flex-col items-center justify-center h-64 text-muted-foreground">
          <Loader2 class="w-10 h-10 mb-4 animate-spin opacity-50" />
          <p class="text-sm">Loading models...</p>
        </div>
      {:else if filteredModels.length === 0}
        <div class="flex flex-col items-center justify-center h-64 text-muted-foreground">
          <Info class="w-12 h-12 mb-4 opacity-50" />
          <p class="text-lg font-medium">No models found</p>
          <p class="text-sm">Try adjusting your search or filters</p>
          <div class="flex items-center gap-2 mt-4">
            <Button variant="link" onclick={() => { searchTerm = ""; selectedEngine = "all"; selectedType = "all"; showUnlisted = false; selectedTags.clear(); }}>
              Clear all filters
            </Button>
            <a href={MODEL_REQUEST_URL} target="_blank" rel="noopener noreferrer" class="text-sm text-primary hover:underline">
              Request a model
            </a>
          </div>
        </div>
      {:else}
        <div class="space-y-8">
          {#each sortedFamilies as family}
            <section>
              <h3 class="text-lg font-bold mb-4 flex items-center gap-2 sticky top-0 bg-background/80 backdrop-blur-sm py-2 z-10 -mx-1 px-1">
                <span class="w-1 h-6 bg-primary rounded-full"></span>
                {family}
                <Badge variant="secondary" class="text-xs font-normal">{groupedModels[family].length}</Badge>
              </h3>
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {#each groupedModels[family] as group (group.leader.publicSpecifier)}
                  {@const groupReason = groupIncompatibility(group, undeployableReason)}
                  <ModelChoiceCard
                    model={group.leader}
                    blockedReason={groupReason}
                    blockedDetail={groupReason === "version_blocked" ? blockedReleaseNote(group.leader) : undefined}
                    {maxNodeFreeCapacity}
                    variantCount={group.variants.length}
                    onSelect={() => chooseFromGroup(group)}
                  />
                {/each}
              </div>
            </section>
          {/each}
        </div>

        <!-- Pagination status + sentinel -->
        <div class="mt-8 flex flex-col items-center gap-3">
          {#if modelCatalog.loadError}
            <div class="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle class="w-4 h-4" />
              <span>Failed to load more: {modelCatalog.loadError}</span>
              <Button variant="outline" size="sm" onclick={() => modelCatalog.retry()}>Retry</Button>
            </div>
          {:else if modelCatalog.isLoading}
            <div class="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 class="w-4 h-4 animate-spin" />
              <span>Loading more models...</span>
            </div>
          {:else if !modelCatalog.hasMore}
            <p class="text-xs text-muted-foreground">All {modelCatalog.totalCount} models loaded</p>
          {/if}
          <div bind:this={sentinel}></div>
        </div>
      {/if}
    </main>
  </div>
</Modal>

{#if pickingFrom}
  {@const group = pickingFrom}
  <Modal open onClose={() => (pickingFrom = null)} class="z-50">
    <div class="bg-card rounded-xl shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden">
      <header class="p-5 border-b flex justify-between items-start gap-4 bg-muted/50">
        <div class="min-w-0">
          <h2 class="text-xl font-bold truncate">{group.leader.name}</h2>
          <p class="text-sm text-muted-foreground mt-1">
            {group.variants.length} variants
          </p>
        </div>
        <Button variant="ghost" size="icon" onclick={() => (pickingFrom = null)} class="shrink-0">
          <X class="w-5 h-5" />
        </Button>
      </header>

      <main class="p-5 overflow-y-auto">
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {#each group.variants as variant, i (variant.publicSpecifier)}
            {@const variantReason = undeployableReason(variant)}
            <ModelChoiceCard
              model={variant}
              blockedReason={variantReason}
              blockedDetail={variantReason === "version_blocked" ? blockedReleaseNote(variant) : undefined}
              {maxNodeFreeCapacity}
              repeatsPreviousDescription={variant.description === group.variants[i - 1]?.description}
              onSelect={handleSelect}
            />
          {/each}
        </div>
      </main>
    </div>
  </Modal>
{/if}
