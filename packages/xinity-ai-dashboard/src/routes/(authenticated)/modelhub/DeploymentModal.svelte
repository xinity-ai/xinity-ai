<script lang="ts">
  import type { ModelWithSpecifier } from "xinity-infoserver";
  import Modal from "$lib/components/Modal.svelte";
  import DeploymentFormBody from "./DeploymentFormBody.svelte";
  import { driverHasTag } from "xinity-infoserver";
  import { orpc } from "$lib/orpc/orpc-client";

  import { toastState } from "$lib/state/toast.svelte";
  import { browserLogger } from "$lib/browserLogging";
  import CustomCodeConsent from "./CustomCodeConsent.svelte";
  import type { DeploymentDefinition } from "./+page.server";

  import { Button } from "$lib/components/ui/button";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { X } from "@lucide/svelte";
  import { isDefinedError } from "@orpc/client";

  // --- Props ---
  let {
    open = $bindable(false),
    deployment,
    close,
    maxNodeFreeCapacity = Infinity,
    availableDrivers = [],
    nodeFreeCapacities = [],
    onSaved = async () => {},
  }: {
    open: boolean;
    deployment?: DeploymentDefinition;
    close: () => void;
    maxNodeFreeCapacity?: number;
    availableDrivers?: string[];
    nodeFreeCapacities?: number[];
    onSaved?: () => Promise<void>;
  } = $props();

  const isEditMode = $derived(Boolean(deployment));
  const idSuffix = $derived(isEditMode ? "-edit" : "");

  // --- Form State ---
  let publicSpecifier = $state("");
  let publicSpecifierEdited = $state(false);
  let publicSpecifierError = $state<string | undefined>(undefined);
  let deploymentName = $state("");
  let deploymentNameEdited = $state(false);
  let enabled = $state(true);
  let selectedPrimarySpecifier = $state<string | null>(null);
  let selectedCanarySpecifier = $state<string | null>(null);
  let isCanaryEnabled = $state(false);
  let canaryTraffic = $state(5);
  let advancementStrategy = $state<"manual" | "time-based" | "smart-auto">("manual");
  let timeBasedDurationHours = $state(72);
  let kvCacheSize = $state<number | null>(null);
  let earlyKvCacheSize = $state<number | null>(null);
  let preferredDriver = $state<"ollama" | "vllm" | null>(null);
  let replicas = $state(1);
  let customCodeConsent = $state(false);
  let shouldAutoSelectCanary = $state(true);

  // --- Edit mode tracking ---
  type Snapshot = {
    name: string; publicSpecifier: string; enabled: boolean;
    earlyModelSpecifier: string | null; progress: number;
    canaryProgressWithFeedback: boolean;
    preferredDriver: string | null; replicas: number; kvCacheSize: number | null;
    earlyKvCacheSize: number | null;
  };
  let initialSnapshot = $state<Snapshot | null>(null);
  let lastInitDeploymentId = $state<string | undefined>(undefined);

  // --- Fetched model state ---
  let selectedPrimaryModel = $state<ModelWithSpecifier | null>(null);
  let selectedCanaryModel = $state<ModelWithSpecifier | null>(null);

  // --- Helpers ---
  function fetchModel(specifier: string | null, set: (m: ModelWithSpecifier | null) => void) {
    if (!specifier) { set(null); return; }
    orpc.model.get({ specifier }).then(([error, data]) => {
      if (error) { toastState.add(`Failed to load model info: ${error.message}`, "error"); return; }
      set(data ?? null);
    });
  }

  function resolveProviderModel(
    model: { providers: { vllm?: string; ollama?: string }; publicSpecifier: string },
    driver?: string | null,
  ): string {
    if (driver) {
      const specific = model.providers[driver as keyof typeof model.providers];
      if (specific) return specific;
    }
    return Object.values(model.providers)[0] ?? model.publicSpecifier;
  }

  function deriveAdvancementStrategy(d: DeploymentDefinition) {
    if (!d.earlyModelSpecifier) return "manual" as const;
    if (d.canaryProgressWithFeedback) return "smart-auto" as const;
    if (d.canaryProgressUntil) return "time-based" as const;
    return "manual" as const;
  }

  // --- Initialize from deployment (edit mode) ---
  $effect(() => {
    const d = deployment;
    if (!d || d.id === lastInitDeploymentId) return;
    lastInitDeploymentId = d.id;

    publicSpecifier = d.publicSpecifier;
    publicSpecifierEdited = true;
    deploymentName = d.name;
    deploymentNameEdited = true;
    enabled = d.enabled;
    selectedPrimarySpecifier = d.modelSpecifier;
    selectedCanarySpecifier = d.earlyModelSpecifier ?? null;
    isCanaryEnabled = Boolean(d.earlyModelSpecifier);
    canaryTraffic = d.progress ?? 100;
    kvCacheSize = d.kvCacheSize ?? null;
    earlyKvCacheSize = d.earlyKvCacheSize ?? null;
    preferredDriver = d.preferredDriver ?? null;
    replicas = d.replicas;
    customCodeConsent = false;
    shouldAutoSelectCanary = true;
    advancementStrategy = deriveAdvancementStrategy(d);
    if (advancementStrategy === "time-based") {
      const from = d.canaryProgressFrom ?? new Date();
      timeBasedDurationHours = Math.max(1, Math.round((d.canaryProgressUntil!.getTime() - from.getTime()) / 3_600_000));
    }

    initialSnapshot = {
      name: d.name, publicSpecifier: d.publicSpecifier, enabled: d.enabled,
      earlyModelSpecifier: d.earlyModelSpecifier ?? null, progress: d.progress,
      canaryProgressWithFeedback: d.canaryProgressWithFeedback,
      preferredDriver: d.preferredDriver ?? null, replicas: d.replicas,
      kvCacheSize: d.kvCacheSize ?? null, earlyKvCacheSize: d.earlyKvCacheSize ?? null,
    };
  });

  $effect(() => {
    if (!deployment) { lastInitDeploymentId = undefined; initialSnapshot = null; }
  });

  // --- Model fetching ---
  $effect(() => fetchModel(selectedPrimarySpecifier, m => selectedPrimaryModel = m));
  $effect(() => fetchModel(selectedCanarySpecifier, m => selectedCanaryModel = m));

  // --- Derived values ---
  const minKvCache = $derived(selectedPrimaryModel?.minKvCache ?? 0);
  const minCanaryKvCache = $derived(selectedCanaryModel?.minKvCache ?? 0);

  const maxKvCache = $derived(
    selectedPrimaryModel ? Math.max(minKvCache, Math.floor((maxNodeFreeCapacity - selectedPrimaryModel.weight) * 10) / 10) : 0,
  );
  const maxCanaryKvCache = $derived(
    selectedCanaryModel ? Math.max(minCanaryKvCache, Math.floor((maxNodeFreeCapacity - selectedCanaryModel.weight) * 10) / 10) : 0,
  );

  const canaryTypeMismatch = $derived(
    Boolean(isCanaryEnabled && selectedPrimaryModel && selectedCanaryModel &&
      selectedPrimaryModel.type !== selectedCanaryModel.type),
  );

  const maxReplicas = $derived.by(() => {
    if (!selectedPrimaryModel) return 0;
    const perReplica = selectedPrimaryModel.weight + Math.max(kvCacheSize ?? 0, selectedPrimaryModel.minKvCache);
    const nodesWithSpace = nodeFreeCapacities.filter(c => c >= perReplica).length;
    return nodesWithSpace + (isEditMode && deployment ? (deployment.replicas ?? 0) : 0);
  });

  const replicasExceedCapacity = $derived(replicas > maxReplicas && selectedPrimaryModel !== null);
  const showTrafficSlider = $derived(!isEditMode || advancementStrategy === "manual");
  const requiresDisabled = $derived(isEditMode && enabled);

  // --- Capacity re-enable check (edit mode) ---
  let cannotReEnable = $state(false);
  let cannotReEnableReason = $state<string | undefined>(undefined);

  $effect(() => {
    if (!isEditMode || !deployment || deployment.enabled) {
      cannotReEnable = false; cannotReEnableReason = undefined; return;
    }
    const abort = new AbortController();
    orpc.deployment.checkCapacity({
      modelSpecifier: selectedPrimarySpecifier!,
      earlyModelSpecifier: isCanaryEnabled ? selectedCanarySpecifier : null,
      replicas, progress: isCanaryEnabled ? canaryTraffic : 100, kvCacheSize,
      earlyKvCacheSize: isCanaryEnabled ? earlyKvCacheSize : null,
    }, { signal: abort.signal }).then(([error, data]) => {
      if (abort.signal.aborted) return;
      if (error) { browserLogger.error({ error }, "Capacity check failed"); cannotReEnable = false; return; }
      cannotReEnable = !data.deployable;
      cannotReEnableReason = data.reason;
    });
    return () => abort.abort();
  });

  const requiresCustomCodeConsent = $derived.by(() => {
    if (!selectedPrimaryModel) return false;
    const effectiveDriver = preferredDriver ?? (selectedPrimaryModel.providers.vllm ? "vllm" : "ollama");
    if (!driverHasTag(selectedPrimaryModel, effectiveDriver, "custom_code")) return false;
    if (isEditMode && deployment) {
      const initialDriver = deployment.preferredDriver ?? (selectedPrimaryModel.providers.vllm ? "vllm" : "ollama");
      if (driverHasTag(selectedPrimaryModel, initialDriver, "custom_code")) return false;
    }
    return true;
  });

  const isFormValid = $derived(Boolean(
    selectedPrimaryModel && deploymentName.trim() && publicSpecifier.trim() &&
    (!isCanaryEnabled || (selectedCanaryModel && !canaryTypeMismatch)) &&
    (kvCacheSize === null || kvCacheSize >= minKvCache) &&
    (!isCanaryEnabled || earlyKvCacheSize === null || earlyKvCacheSize >= minCanaryKvCache) &&
    (!requiresCustomCodeConsent || customCodeConsent) &&
    !replicasExceedCapacity && !(isEditMode && enabled && cannotReEnable) && replicas >= 1,
  ));

  const hasChanges = $derived.by(() => {
    if (!isEditMode || !initialSnapshot) return true;
    const s = initialSnapshot;
    return (
      deploymentName.trim() !== s.name.trim() ||
      publicSpecifier.trim() !== s.publicSpecifier.trim() ||
      enabled !== s.enabled ||
      (isCanaryEnabled ? (selectedCanarySpecifier ?? null) : null) !== s.earlyModelSpecifier ||
      (isCanaryEnabled ? canaryTraffic : 100) !== s.progress ||
      (isCanaryEnabled && advancementStrategy === "smart-auto") !== s.canaryProgressWithFeedback ||
      (preferredDriver ?? null) !== s.preferredDriver ||
      replicas !== s.replicas ||
      (kvCacheSize ?? null) !== s.kvCacheSize ||
      (earlyKvCacheSize ?? null) !== s.earlyKvCacheSize
    );
  });

  // --- Create-mode effects ---
  $effect(() => {
    if (isEditMode) return;
    const model = selectedPrimaryModel;
    if (!publicSpecifierEdited) publicSpecifier = model?.publicSpecifier || "";
    if (!deploymentNameEdited) deploymentName = model?.name || "";
  });

  $effect(() => { if (!isEditMode) kvCacheSize = selectedPrimaryModel?.minKvCache ?? null; });
  $effect(() => { if (!isEditMode) earlyKvCacheSize = selectedCanaryModel?.minKvCache ?? null; });

  $effect(() => {
    if (isEditMode || !selectedPrimaryModel) return;
    const model = selectedPrimaryModel;
    const driverOptions = availableDrivers.filter(d => model.providers[d as keyof typeof model.providers] !== undefined);
    if (driverOptions.length === 1) {
      preferredDriver = driverOptions[0] as "ollama" | "vllm";
    } else if (preferredDriver && !model.providers[preferredDriver as keyof typeof model.providers]) {
      preferredDriver = null;
    }
  });

  $effect(() => { if (!isEditMode) { selectedPrimarySpecifier; preferredDriver; customCodeConsent = false; } });

  // Pre-select canary base model for custom models
  $effect(() => {
    if (isEditMode ? !shouldAutoSelectCanary : false) return;
    const baseModel = selectedPrimaryModel?.isCustom ? selectedPrimaryModel.custom?.baseModel : undefined;
    if (!baseModel || selectedCanaryModel) return;
    fetchModel(baseModel, (data) => {
      if (!data) return;
      if (isEditMode && !selectedCanarySpecifier) {
        selectedCanarySpecifier = baseModel;
        isCanaryEnabled = true;
      } else if (!isEditMode) {
        selectedCanarySpecifier = baseModel;
      }
    });
  });

  // Edit mode: clear canary when disabled
  $effect(() => { if (isEditMode && !isCanaryEnabled) selectedCanarySpecifier = null; });

  // Edit mode: re-resolve canary specifier when driver changes
  $effect(() => {
    if (!isEditMode || !selectedCanaryModel || !isCanaryEnabled || !preferredDriver) return;
    const newSpec = selectedCanaryModel.providers[preferredDriver as keyof typeof selectedCanaryModel.providers];
    if (newSpec && newSpec !== selectedCanarySpecifier) selectedCanarySpecifier = newSpec;
  });

  // --- Submit ---
  async function handleSubmit() {
    if (!isFormValid || !selectedPrimaryModel) return;

    const [error] = isEditMode
      ? await orpc.deployment.update({
          ...deployment!,
          name: deploymentName.trim(),
          publicSpecifier: publicSpecifier.trim(),
          enabled,
          earlyModelSpecifier: isCanaryEnabled ? (selectedCanarySpecifier ?? null) : null,
          progress: isCanaryEnabled ? canaryTraffic : 100,
          canaryProgressWithFeedback: isCanaryEnabled && advancementStrategy === "smart-auto",
          canaryProgressFrom: isCanaryEnabled && advancementStrategy !== "manual"
            ? (deployment!.canaryProgressFrom ?? new Date()) : null,
          canaryProgressUntil: isCanaryEnabled && advancementStrategy === "time-based"
            ? new Date(Date.now() + timeBasedDurationHours * 3_600_000) : null,
          kvCacheSize,
          earlyKvCacheSize: isCanaryEnabled ? earlyKvCacheSize : null,
          preferredDriver: preferredDriver || null, replicas,
        })
      : await orpc.deployment.create({
          enabled, name: deploymentName.trim(), publicSpecifier: publicSpecifier.trim(),
          modelSpecifier: resolveProviderModel(selectedPrimaryModel, preferredDriver),
          replicas, canaryProgressWithFeedback: advancementStrategy === "smart-auto",
          kvCacheSize: kvCacheSize && kvCacheSize > minKvCache ? kvCacheSize : undefined,
          earlyKvCacheSize: isCanaryEnabled && selectedCanaryModel && earlyKvCacheSize && earlyKvCacheSize > minCanaryKvCache ? earlyKvCacheSize : undefined,
          preferredDriver: preferredDriver || null,
          earlyModelSpecifier: isCanaryEnabled && selectedCanaryModel
            ? resolveProviderModel(selectedCanaryModel, preferredDriver) : undefined,
          progress: isCanaryEnabled && selectedCanaryModel ? canaryTraffic : undefined,
          canaryProgressFrom: isCanaryEnabled && selectedCanaryModel ? new Date() : undefined,
          canaryProgressUntil: isCanaryEnabled && selectedCanaryModel && advancementStrategy === "time-based"
            ? new Date(Date.now() + timeBasedDurationHours * 3_600_000) : undefined,
        });

    if (error) {
      if(isDefinedError(error) && error.code === "CONFLICT") {
        publicSpecifierError = error.message ?? "A deployment with this specifier already exists in your organization";
      } else {
        toastState.add(`Failed to ${isEditMode ? "update" : "create"} deployment: ${error.message}`, "error");
      }
    } else {
      close();
      if (!isEditMode) clearState();
    }
    await onSaved();
  }

  function clearState() {
    publicSpecifier = ""; publicSpecifierEdited = false; publicSpecifierError = undefined;
    deploymentName = ""; deploymentNameEdited = false;
    enabled = true;
    selectedPrimarySpecifier = null; selectedCanarySpecifier = null;
    isCanaryEnabled = false; canaryTraffic = 5;
    advancementStrategy = "manual"; timeBasedDurationHours = 72;
    kvCacheSize = null; earlyKvCacheSize = null; preferredDriver = null; replicas = 1;
    customCodeConsent = false; shouldAutoSelectCanary = true;
  }
</script>

<Modal {open} onClose={close} class="z-40">
  {#if open}
    <div class="bg-card rounded-xl shadow-2xl w-full max-w-4xl min-w-[min(56rem,90vw)] max-h-[90vh] flex flex-col">
      <header class="p-6 border-b flex justify-between items-center">
        <h2 class="text-2xl font-semibold">
          {isEditMode ? "Edit Deployment" : "Create New Deployment"}
        </h2>
        <Button variant="ghost" size="icon" onclick={close} aria-label="Close modal">
          <X class="w-5 h-5" />
        </Button>
      </header>

      <main class="p-6 grow overflow-y-auto space-y-8">
        <DeploymentFormBody
          selectedPrimaryModel={selectedPrimaryModel ?? undefined}
          selectedCanaryModel={selectedCanaryModel ?? undefined}
          {maxNodeFreeCapacity}
          {availableDrivers}
          {maxReplicas}
          editMode={isEditMode}
          readonlyModels={requiresDisabled}
          {requiresDisabled}
          bind:primarySpecifier={selectedPrimarySpecifier}
          bind:canarySpecifier={selectedCanarySpecifier}
          bind:publicSpecifier
          bind:deploymentName
          bind:isCanaryEnabled
          bind:canaryTraffic
          bind:advancementStrategy
          bind:timeBasedDurationHours
          bind:replicas
          bind:kvCacheSize
          bind:earlyKvCacheSize
          {maxKvCache}
          {maxCanaryKvCache}
          bind:preferredDriver
          {canaryTypeMismatch}
          {showTrafficSlider}
          {publicSpecifierError}
          onPublicSpecifierInput={() => { publicSpecifierEdited = true; publicSpecifierError = undefined; }}
          onDeploymentNameInput={() => (deploymentNameEdited = true)}
          onCanaryEnabledChange={isEditMode ? () => (shouldAutoSelectCanary = false) : undefined}
          {idSuffix}
        />

        {#if requiresCustomCodeConsent}
          <CustomCodeConsent bind:consented={customCodeConsent} {idSuffix} />
        {/if}
      </main>

      <footer class="p-6 border-t bg-muted/50 rounded-b-xl flex justify-between items-center gap-4">
        <label
          for="enabled{idSuffix}"
          class="flex items-center gap-2 py-1.5 px-1 -ml-1 rounded select-none {isEditMode && cannotReEnable && !enabled ? 'cursor-not-allowed' : 'cursor-pointer'}"
        >
          <Checkbox
            id="enabled{idSuffix}"
            checked={enabled}
            disabled={isEditMode && cannotReEnable && !enabled}
            onCheckedChange={(checked) => enabled = checked === true}
          />
          <span class="text-sm {isEditMode && cannotReEnable ? 'text-muted-foreground' : ''}">
            {isEditMode ? "Enabled" : "Start deployment in enabled state"}
          </span>
          {#if isEditMode && cannotReEnable && !enabled}
            <span class="text-sm text-destructive">{cannotReEnableReason ?? "Insufficient cluster capacity"}</span>
          {/if}
        </label>
        <div class="flex items-center gap-3">
          <Button variant="outline" onclick={close}>Cancel</Button>
          <Button onclick={handleSubmit} disabled={!isFormValid || (isEditMode && !hasChanges)}>
            {isEditMode ? "Save" : "Deploy Model"}
          </Button>
        </div>
      </footer>
    </div>
  {/if}
</Modal>
