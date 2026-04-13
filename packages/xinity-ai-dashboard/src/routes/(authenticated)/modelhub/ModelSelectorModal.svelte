<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import type { ModelWithSpecifier } from "xinity-infoserver";
  import { resolveAllTags, resolveTagsForDriver, driverHasTag } from "xinity-infoserver";
  import { modelCatalog } from "$lib/state/model-catalog.svelte";

  // shadcn components
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Badge } from "$lib/components/ui/badge";

  // Icons
  import { X, Search, ExternalLink, Info, ShieldAlert, HardDrive, Loader2, AlertCircle } from "@lucide/svelte";

  /** Minimum number of filtered results before auto-loading the next page. */
  const MIN_RESULTS_THRESHOLD = 10;

  // --- Props ---
  let {
    open = $bindable(false),
    onSelect,
    onClose,
    maxNodeFreeCapacity = Infinity,
  }: {
    open: boolean;
    onSelect: (model: ModelWithSpecifier) => void;
    onClose: () => void;
    maxNodeFreeCapacity?: number;
  } = $props();

  // --- Filter State ---
  let searchTerm = $state("");
  let selectedType = $state<"all" | "chat" | "embedding" | "rerank">("all");
  let selectedTags = $state<Set<string>>(new Set());
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
    searchTerm; selectedType; selectedTags;
    if (filteredModels.length < MIN_RESULTS_THRESHOLD) {
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
  const allTags = $derived(
    Array.from(new Set(modelCatalog.models.flatMap((m) => resolveAllTags(m)))).sort(),
  );

  // Insertion order preserved; no re-sort prevents layout shifts when new pages arrive
  const filteredModels = $derived(
    modelCatalog.models.filter((m) => {
      const tags = resolveAllTags(m);
      const searchLower = searchTerm.toLowerCase();
      const matchesSearch =
        !searchLower ||
        m.name.toLowerCase().includes(searchLower) ||
        m.description.toLowerCase().includes(searchLower) ||
        m.publicSpecifier.toLowerCase().includes(searchLower) ||
        (m.family && m.family.toLowerCase().includes(searchLower));

      let matchesType = true;
      if (selectedType === "chat") matchesType = m.type === "chat";
      else if (selectedType === "embedding") matchesType = m.type === "embedding";
      else if (selectedType === "rerank") matchesType = m.type === "rerank";

      const matchesTags =
        selectedTags.size === 0 ||
        Array.from(selectedTags).every((t) => tags.includes(t));

      return matchesSearch && matchesType && matchesTags;
    }),
  );

  const groupedModels = $derived(
    filteredModels.reduce(
      (acc, model) => {
        const family = model.family || "Other";
        if (!acc[family]) acc[family] = [];
        acc[family].push(model);
        return acc;
      },
      {} as Record<string, ModelWithSpecifier[]>,
    ),
  );

  const sortedFamilies = $derived(Object.keys(groupedModels).sort());

  // --- Functions ---
  function toggleTag(tag: string) {
    selectedTags = selectedTags.has(tag)
      ? new Set([...selectedTags].filter((t) => t !== tag))
      : new Set([...selectedTags, tag]);
  }

  function exceedsCapacity(model: ModelWithSpecifier): boolean {
    return model.weight + model.minKvCache > maxNodeFreeCapacity;
  }

  function handleSelect(model: ModelWithSpecifier) {
    if (exceedsCapacity(model)) return;
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
      <Button variant="ghost" size="icon" onclick={onClose} aria-label="Close modal">
        <X class="w-5 h-5" />
      </Button>
    </header>

    <!-- Controls -->
    <div class="p-5 border-b bg-card space-y-4">
      <div class="flex flex-col md:flex-row gap-4">
        <div class="relative grow">
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

        <div class="flex bg-muted p-1 rounded-lg shrink-0">
          {#each ["all", "chat", "embedding", "rerank"] as type}
            <button
              class="px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 capitalize {selectedType === type ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}"
              onclick={() => (selectedType = type as any)}
            >
              {type}
            </button>
          {/each}
        </div>
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
      <div class="px-5 py-3 border-b bg-muted/30 flex items-center gap-2 text-sm">
        <HardDrive class="w-4 h-4 text-muted-foreground shrink-0" />
        <span class="text-muted-foreground">Available node capacity:</span>
        <span class="font-semibold">{maxNodeFreeCapacity.toFixed(1)} GB</span>
      </div>
    {/if}

    <!-- Model List -->
    <main class="grow overflow-y-auto p-5 bg-muted/30">
      {#if modelCatalog.loadError && !modelCatalog.initialLoaded}
        <div class="flex flex-col items-center justify-center h-64 text-muted-foreground">
          <AlertCircle class="w-12 h-12 mb-4 text-destructive opacity-70" />
          <p class="text-lg font-medium text-destructive">Failed to load models</p>
          <p class="text-sm mt-1">{modelCatalog.loadError}</p>
          <Button variant="outline" class="mt-4" onclick={() => modelCatalog.loadMore()}>Retry</Button>
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
          <Button variant="link" class="mt-4" onclick={() => { searchTerm = ""; selectedType = "all"; selectedTags = new Set(); }}>
            Clear all filters
          </Button>
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
                {#each groupedModels[family] as model (model.publicSpecifier)}
                  {@const undeployable = exceedsCapacity(model)}
                  {@const modelTags = resolveAllTags(model)}
                  {@const modelDrivers = Object.keys(model.providers) as Array<"vllm" | "ollama">}
                  {@const hasDriverDiffs = model.providerTags !== undefined}
                  <div
                    role="button"
                    tabindex={undeployable ? -1 : 0}
                    aria-disabled={undeployable}
                    class="group relative flex flex-col text-left bg-card border rounded-xl p-4 transition-all duration-200 min-w-0 {undeployable ? 'opacity-40 cursor-not-allowed' : 'hover:shadow-lg hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 cursor-pointer'}"
                    onclick={() => handleSelect(model)}
                    onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelect(model); } }}
                  >
                    <div class="flex justify-between items-start w-full mb-2 gap-2 overflow-hidden">
                      <div class="min-w-0 flex-1">
                        <h4 class="font-semibold group-hover:text-primary transition-colors truncate" title={model.name}>
                          {model.name}
                        </h4>
                        <p class="text-xs text-muted-foreground font-mono mt-0.5 truncate" title={model.publicSpecifier}>
                          {model.publicSpecifier}
                        </p>
                      </div>
                      <div class="flex items-center gap-1.5 shrink-0">
                        {#if model.url}
                          <a href={model.url} target="_blank" rel="noopener noreferrer"
                            class="p-1.5 text-muted-foreground hover:text-primary hover:bg-accent rounded-full transition-colors z-10"
                            title="View model info" onclick={(e) => e.stopPropagation()}>
                            <ExternalLink class="w-4 h-4" />
                          </a>
                        {/if}
                        {#if model.isCustom}
                          <Badge variant="secondary" class="text-[10px] uppercase px-1.5 py-0">Custom</Badge>
                        {:else}
                          <Badge variant="outline" class="text-[10px] uppercase px-1.5 py-0">{model.type}</Badge>
                        {/if}
                      </div>
                    </div>

                    <p class="text-sm text-muted-foreground mb-3 line-clamp-2 grow">{model.description}</p>

                    <div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-3">
                      <HardDrive class="w-3 h-3" />
                      <span>{model.weight + model.minKvCache} GB</span>
                      <span class="opacity-50">({model.weight} model + {model.minKvCache} kv-cache)</span>
                    </div>

                    {#if undeployable}
                      <div class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive mb-1">
                        <ShieldAlert class="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>Exceeds available node capacity ({model.weight + model.minKvCache} GB required, {maxNodeFreeCapacity} GB available)</span>
                      </div>
                    {/if}

                    {#if model.providers.vllm && driverHasTag(model, "vllm", "custom_code")}
                      <div class="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400 mb-1">
                        <ShieldAlert class="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>Requires custom code execution{model.providers.ollama ? " (vLLM)" : ""}. Trust must be granted before deploy.</span>
                      </div>
                    {/if}

                    <div class="flex flex-wrap gap-1.5 mt-auto">
                      {#each modelTags.slice(0, 4) as tag}
                        <Badge variant="secondary" class="text-xs">
                          {tag}
                          {#if hasDriverDiffs}
                            {@const driversWithTag = modelDrivers.filter((d) => resolveTagsForDriver(model, d).includes(tag))}
                            {#if driversWithTag.length < modelDrivers.length}
                              <span class="ml-1 opacity-60">({driversWithTag.map((d) => d === "vllm" ? "vLLM" : "Ollama").join(", ")})</span>
                            {/if}
                          {/if}
                        </Badge>
                      {/each}
                      {#if modelTags.length > 4}
                        <Badge variant="outline" class="text-xs">+{modelTags.length - 4}</Badge>
                      {/if}
                    </div>
                  </div>
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
              <Button variant="outline" size="sm" onclick={() => modelCatalog.loadMore()}>Retry</Button>
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
