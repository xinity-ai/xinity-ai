<script lang="ts">
  import { slide } from "svelte/transition";
  import type { ModelWithSpecifier } from "xinity-infoserver";
  import ModelSelectorModal from "./ModelSelectorModal.svelte";
  import DeploymentModelTile from "./DeploymentModelTile.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import * as Select from "$lib/components/ui/select";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { ChevronDown } from "@lucide/svelte";

  let {
    selectedPrimaryModel,
    selectedCanaryModel,
    primarySpecifier = $bindable(),
    canarySpecifier = $bindable(),
    publicSpecifier = $bindable(),
    deploymentName = $bindable(),
    isCanaryEnabled = $bindable(),
    canaryTraffic = $bindable(),
    advancementStrategy = $bindable(),
    timeBasedDurationHours = $bindable(),
    replicas = $bindable(),
    kvCacheSize = $bindable(),
    earlyKvCacheSize = $bindable(),
    maxKvCache = 0,
    maxCanaryKvCache = 0,
    preferredDriver = $bindable(),
    canaryTypeMismatch,
    editMode = false,
    readonlyModels = false,
    requiresDisabled = false,
    maxReplicas = 0,
    showTrafficSlider = true,
    maxNodeFreeCapacity = Infinity,
    availableDrivers = [],
    onPublicSpecifierInput,
    onDeploymentNameInput,
    onCanaryEnabledChange,
    idSuffix = "",
    publicSpecifierError,
  }: {
    selectedPrimaryModel: ModelWithSpecifier | undefined;
    selectedCanaryModel: ModelWithSpecifier | undefined;
    primarySpecifier: string | null;
    canarySpecifier: string | null | undefined;
    publicSpecifier: string;
    deploymentName: string;
    isCanaryEnabled: boolean;
    canaryTraffic: number;
    advancementStrategy: "manual" | "time-based" | "smart-auto";
    timeBasedDurationHours: number;
    replicas: number;
    kvCacheSize: number | null;
    earlyKvCacheSize: number | null;
    maxKvCache: number;
    maxCanaryKvCache: number;
    preferredDriver: "ollama" | "vllm" | null;
    canaryTypeMismatch: boolean;
    editMode?: boolean;
    readonlyModels?: boolean;
    requiresDisabled?: boolean;
    maxReplicas?: number;
    showTrafficSlider?: boolean;
    maxNodeFreeCapacity?: number;
    availableDrivers?: string[];
    publicSpecifierError?: string;
    onPublicSpecifierInput?: () => void;
    onDeploymentNameInput?: () => void;
    onCanaryEnabledChange?: (enabled: boolean) => void;
    idSuffix?: string;
  } = $props();

  let showModelSelector = $state(false);
  let selectorMode = $state<"primary" | "canary">("primary");
  let showSelectModel = $state(true);
  let showConfigureDeployment = $state(true);
  let showCanaryDeployment = $state(true);
  let showExpertSettings = $state(false);

  // --- Derived ---
  const minKvCache = $derived(selectedPrimaryModel?.minKvCache ?? 0);
  const minCanaryKvCache = $derived(selectedCanaryModel?.minKvCache ?? 0);
  const replicasExceedCapacity = $derived(replicas > maxReplicas && selectedPrimaryModel !== undefined);

  const modelDriverOptions = $derived.by(() => {
    const m = selectedPrimaryModel;
    if (!m) return [];
    return availableDrivers.filter(d => m.providers[d as keyof typeof m.providers] !== undefined);
  });
  const singleDriverOnly = $derived(modelDriverOptions.length === 1);

  const selectorCapacity = $derived.by(() => {
    if (selectorMode === "canary" && selectedPrimaryModel) {
      return maxNodeFreeCapacity - (selectedPrimaryModel.weight + selectedPrimaryModel.minKvCache);
    }
    if (selectorMode === "primary" && isCanaryEnabled && selectedCanaryModel) {
      return maxNodeFreeCapacity - (selectedCanaryModel.weight + selectedCanaryModel.minKvCache);
    }
    return maxNodeFreeCapacity;
  });

  function driverLabel(d: string) { return d === "vllm" ? "vLLM" : "Ollama"; }

  const advancementStrategyLabels: Record<string, string> = {
    manual: "Manual",
    "time-based": "Time-Based",
  };
  const advancementStrategyLabel = $derived(advancementStrategyLabels[advancementStrategy] ?? "Select...");

  // Use "" as sentinel for null since bits-ui Select values must be strings
  let preferredDriverStr = $derived(preferredDriver ?? "");
  const preferredDriverLabel = $derived(
    preferredDriverStr === "" ? "Auto" : driverLabel(preferredDriverStr),
  );

  function openSelector(mode: "primary" | "canary") {
    selectorMode = mode;
    showModelSelector = true;
  }

  function handleModelSelect(model: ModelWithSpecifier) {
    if (selectorMode === "primary") {
      primarySpecifier = model.publicSpecifier;
    } else {
      canarySpecifier = model.publicSpecifier;
    }
    showModelSelector = false;
  }
</script>

{#snippet sectionHeader(title: string, open: boolean)}
  <Collapsible.Trigger
    class="flex items-center gap-2 text-lg font-medium mb-4 compact:mb-2 hover:text-primary transition-colors cursor-pointer"
  >
    <ChevronDown class="w-5 h-5 transition-transform {open ? 'rotate-0' : '-rotate-90'}" />
    {title}
  </Collapsible.Trigger>
{/snippet}

{#snippet modelTile(model: ModelWithSpecifier | undefined, specifier: string | null, color: "blue" | "purple", mode: "primary" | "canary", disabledSpec?: string | null)}
  {#if !model}
    {#if !readonlyModels}
      <button
        class="w-full {mode === 'primary' ? 'py-8 compact:py-4' : 'py-6 compact:py-3'} border-2 border-dashed rounded-lg text-muted-foreground hover:border-{color === 'blue' ? 'primary' : 'purple-500'} hover:text-{color === 'blue' ? 'primary' : 'purple-500'} transition-colors flex flex-col items-center justify-center gap-{mode === 'primary' ? '2' : '1'}"
        onclick={() => openSelector(mode)}
      >
        <span class="{mode === 'primary' ? 'text-lg' : ''} font-medium">
          {mode === 'primary' ? 'Select a Model' : 'Select Canary Model'}
        </span>
        {#if mode === "primary"}
          <span class="text-sm">Click to browse available models</span>
        {/if}
      </button>
    {/if}
  {:else}
    <div class="relative">
      <DeploymentModelTile
        {model}
        selectedSpecifier={specifier}
        {color}
        disabledSpecifier={disabledSpec ?? null}
        blockSelectWhenDisabled={mode === "canary" ? false : true}
        onSelect={readonlyModels ? undefined : () => openSelector(mode)}
      />
      {#if !readonlyModels}
        <div class="absolute top-4 right-4 z-10">
          <Button
            variant="secondary"
            size="sm"
            onclick={(e) => { e.stopPropagation(); openSelector(mode); }}
          >
            Change
          </Button>
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

<!-- 1. Model Selection -->
<Collapsible.Root bind:open={showSelectModel}>
  <section>
    {@render sectionHeader(
      editMode ? "1. Model" : "1. Select Model",
      showSelectModel,
    )}
    <Collapsible.Content>
      {@render modelTile(selectedPrimaryModel, primarySpecifier, "blue", "primary")}
      {#if readonlyModels}
        <p class="text-sm text-muted-foreground mt-2">Disable the deployment to change models.</p>
      {/if}
    </Collapsible.Content>
  </section>
</Collapsible.Root>

<!-- 2. Deployment Configuration -->
<Collapsible.Root bind:open={showConfigureDeployment}>
  <section>
    {@render sectionHeader(
      editMode ? "2. Deployment Configuration" : "2. Configure Deployment",
      showConfigureDeployment,
    )}
    <Collapsible.Content class="space-y-4">
      <div class="space-y-2">
        <Label for="public-specifier{idSuffix}">
          Public Specifier <span class="text-destructive">*</span>
        </Label>
        <Input
          type="text"
          id="public-specifier{idSuffix}"
          bind:value={publicSpecifier}
          oninput={() => onPublicSpecifierInput?.()}
          placeholder="e.g., my-chatbot or company/translator-en-de"
          required
          aria-invalid={publicSpecifierError ? true : undefined}
        />
        {#if publicSpecifierError}
          <p class="text-sm text-destructive">{publicSpecifierError}</p>
        {:else}
          <p class="text-sm text-muted-foreground">
            This is the public-facing name used to invoke the model via the API.
          </p>
        {/if}
      </div>
      <div class="space-y-2">
        <Label for="deployment-name{idSuffix}">
          Deployment Name <span class="text-destructive">*</span>
        </Label>
        <Input
          type="text"
          id="deployment-name{idSuffix}"
          bind:value={deploymentName}
          oninput={() => onDeploymentNameInput?.()}
          placeholder="e.g. Customer Support V1 Deployment"
          required
        />
        <p class="text-sm text-muted-foreground">
          This is the name used to list the model.
        </p>
      </div>
    </Collapsible.Content>
  </section>
</Collapsible.Root>

<!-- 3. Canary Deployment -->
<Collapsible.Root bind:open={showCanaryDeployment}>
  <section>
    {@render sectionHeader(
      editMode ? "3. Canary Deployment" : "3. Canary Deployment (Optional)",
      showCanaryDeployment,
    )}
    <Collapsible.Content>
      <div class="flex items-center space-x-3 bg-muted/50 p-4 compact:p-2 rounded-lg">
        <Checkbox
          id="canary-toggle{idSuffix}"
          checked={isCanaryEnabled}
          onCheckedChange={(checked) => {
            const enabled = checked === true;
            isCanaryEnabled = enabled;
            onCanaryEnabledChange?.(enabled);
          }}
        />
        <Label for="canary-toggle{idSuffix}" class="cursor-pointer">
          Enable Canary Deployment
        </Label>
      </div>

      {#if isCanaryEnabled}
        <div
          transition:slide={{ duration: 300 }}
          class="mt-4 compact:mt-2 space-y-6 compact:space-y-3 pt-4 compact:pt-2 border-t"
        >
          <div>
            <h4 class="font-medium mb-2">Select Canary Model</h4>
            {@render modelTile(selectedCanaryModel, canarySpecifier ?? null, "purple", "canary", primarySpecifier)}
            {#if canaryTypeMismatch}
              <p class="text-sm text-destructive mt-2">
                Model types do not match: primary is "{selectedPrimaryModel?.type}" but canary is "{selectedCanaryModel?.type}".
                Canary deployments require both models to be of the same type.
              </p>
            {/if}
          </div>

          {#if selectedCanaryModel}
            <div class="space-y-2">
              <Label for="canary-kv-cache-size{idSuffix}">
                Canary KV Cache Size: <span class="font-bold text-primary">{earlyKvCacheSize ?? minCanaryKvCache} GB</span>
              </Label>
              {#if requiresDisabled}
                <input
                  id="canary-kv-cache-size{idSuffix}"
                  type="range" min={minCanaryKvCache} max={maxCanaryKvCache || minCanaryKvCache + 1} step="1"
                  value={earlyKvCacheSize ?? minCanaryKvCache}
                  disabled
                  class="w-full h-2 bg-muted rounded-lg appearance-none cursor-not-allowed opacity-50"
                />
                <p class="text-sm text-muted-foreground">Disable the deployment to change the KV cache size.</p>
              {:else}
                <input
                  id="canary-kv-cache-size{idSuffix}"
                  type="range" min={minCanaryKvCache} max={maxCanaryKvCache || minCanaryKvCache + 1} step="1"
                  bind:value={earlyKvCacheSize}
                  class="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
                />
                <p class="text-sm text-muted-foreground">
                  Min: {minCanaryKvCache} GB · Max: {maxCanaryKvCache} GB.
                </p>
              {/if}
              {#if earlyKvCacheSize !== null && earlyKvCacheSize < minCanaryKvCache}
                <p class="text-sm text-destructive">Value must be at least {minCanaryKvCache} GB for the canary model.</p>
              {/if}
            </div>
          {/if}

          {#if showTrafficSlider}
            <div class="space-y-2">
              <Label for="canary-traffic{idSuffix}">
                Initial Traffic to Canary: <span class="font-bold text-primary">{canaryTraffic}%</span>
              </Label>
              <input
                id="canary-traffic{idSuffix}"
                type="range" min="0" max="100" step="1"
                bind:value={canaryTraffic}
                class="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
              />
            </div>
          {/if}

          <div class="space-y-2">
            <Label for="advancement-strategy{idSuffix}">Advancement Strategy</Label>
            <Select.Root type="single" bind:value={advancementStrategy}>
              <Select.Trigger id="advancement-strategy{idSuffix}" class="w-full">
                {advancementStrategyLabel}
              </Select.Trigger>
              <Select.Content portalProps={{ disabled: true }}>
                <Select.Item value="manual" label="Manual" />
                <Select.Item value="time-based" label="Time-Based" />
              </Select.Content>
            </Select.Root>
            {#if advancementStrategy === "time-based"}
              <div class="mt-4 space-y-2">
                <Label for="time-duration{idSuffix}">Ramp-up Duration (hours)</Label>
                <Input id="time-duration{idSuffix}" type="number" min="1" bind:value={timeBasedDurationHours} placeholder="e.g., 48" />
                <p class="text-sm text-muted-foreground">
                  Traffic will reach 100% on the canary model after this many hours.
                </p>
              </div>
            {:else}
              <!-- Spacer. Do not remove -->
              <div class="h-24"></div>
            {/if}
          </div>
        </div>
      {/if}
    </Collapsible.Content>
  </section>
</Collapsible.Root>

<!-- 4. Expert Settings -->
{#if selectedPrimaryModel}
  <Collapsible.Root bind:open={showExpertSettings}>
    <section>
      {@render sectionHeader(
        editMode ? "4. Expert Settings" : "4. Expert Settings (Optional)",
        showExpertSettings,
      )}
      <Collapsible.Content class="space-y-4">
        <div class="space-y-2">
          <Label for="replicas{idSuffix}">Replicas</Label>
          <Input id="replicas{idSuffix}" type="number" min={1} step="1" bind:value={replicas} placeholder="1" />
          <p class="text-sm text-muted-foreground">
            Number of model instances to deploy. Each replica uses additional hardware capacity.
            Up to {maxReplicas} {maxReplicas === 1 ? "replica" : "replicas"} can fit in the cluster.
          </p>
          {#if replicasExceedCapacity}
            <p class="text-sm text-destructive">
              Not enough cluster capacity for {replicas} {replicas === 1 ? "replica" : "replicas"}.
              Only {maxReplicas} {maxReplicas === 1 ? "node has" : "nodes have"} enough free capacity.
            </p>
          {/if}
        </div>

        <div class="space-y-2">
          <Label for="kv-cache-size{idSuffix}">
            {isCanaryEnabled ? "Primary " : ""}KV Cache Size: <span class="font-bold text-primary">{kvCacheSize ?? minKvCache} GB</span>
          </Label>
          {#if requiresDisabled}
            <input
              id="kv-cache-size{idSuffix}"
              type="range" min={minKvCache} max={maxKvCache || minKvCache + 1} step="1"
              value={kvCacheSize ?? minKvCache}
              disabled
              class="w-full h-2 bg-muted rounded-lg appearance-none cursor-not-allowed opacity-50"
            />
            <p class="text-sm text-muted-foreground">Disable the deployment to change the KV cache size.</p>
          {:else}
            <input
              id="kv-cache-size{idSuffix}"
              type="range" min={minKvCache} max={maxKvCache || minKvCache + 1} step="1"
              bind:value={kvCacheSize}
              class="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer"
            />
            <p class="text-sm text-muted-foreground">
              Min: {minKvCache} GB · Max: {maxKvCache} GB. Larger values improve throughput for concurrent requests.
            </p>
          {/if}
          {#if kvCacheSize !== null && kvCacheSize < minKvCache}
            <p class="text-sm text-destructive">Value must be at least {minKvCache} GB for this model.</p>
          {/if}
        </div>

        {#if modelDriverOptions.length > 0}
          <div class="space-y-2">
            <Label for="preferred-driver{idSuffix}">Preferred Driver</Label>
            {#if singleDriverOnly}
              <Input id="preferred-driver{idSuffix}" type="text" value={driverLabel(modelDriverOptions[0])} readonly />
              <p class="text-sm text-muted-foreground">This is the only available driver for this model.</p>
            {:else}
              <Select.Root
                type="single"
                value={preferredDriverStr}
                onValueChange={(v) => { preferredDriver = v === "" ? null : v as "ollama" | "vllm"; }}
                disabled={requiresDisabled}
              >
                <Select.Trigger id="preferred-driver{idSuffix}" class="w-full">
                  {preferredDriverLabel}
                </Select.Trigger>
                <Select.Content portalProps={{ disabled: true }}>
                  <Select.Item value="" label="Auto" />
                  {#each modelDriverOptions as driver}
                    <Select.Item value={driver} label={driverLabel(driver)} />
                  {/each}
                </Select.Content>
              </Select.Root>
              <p class="text-sm text-muted-foreground">
                {#if requiresDisabled}
                  Disable the deployment to change the preferred driver.
                {:else}
                  Select which inference driver to use. "Auto" prefers vLLM when available.
                  <a href="/docs/inference-drivers" target="_blank" class="text-primary hover:underline">Learn more about inference drivers</a>
                {/if}
              </p>
            {/if}
          </div>
        {/if}
      </Collapsible.Content>
    </section>
  </Collapsible.Root>
{/if}

<ModelSelectorModal
  bind:open={showModelSelector}
  maxNodeFreeCapacity={selectorCapacity}
  onSelect={handleModelSelect}
  onClose={() => (showModelSelector = false)}
/>
