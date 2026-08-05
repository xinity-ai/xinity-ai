<script lang="ts">
  import type { ModelWithSpecifier, NodeCapability } from "xinity-infoserver";
  import Modal from "$lib/components/Modal.svelte";
  import DeploymentFormBody from "./DeploymentFormBody.svelte";
  import { orpc } from "$lib/orpc/orpc-client";

  import { toastState } from "$lib/state/toast.svelte";
  import { browserLogger } from "$lib/browserLogging";
  import CustomCodeConsent from "./CustomCodeConsent.svelte";
  import type { DeploymentDefinition } from "./+page.server";
  import { settingsEqual, type DeploymentSettings } from "common-db/deployment-settings";
  import { DeploymentSettingsDto } from "$lib/orpc/dtos/model.dto";

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
    nodeFreeCapacities = [],
    nodeCapabilities = [],
    onSaved = async () => {},
  }: {
    open: boolean;
    deployment?: DeploymentDefinition;
    close: () => void;
    maxNodeFreeCapacity?: number;
    nodeFreeCapacities?: number[];
    nodeCapabilities?: NodeCapability[];
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
  let settings = $state<DeploymentSettings>({ version: 1 });
  let preferredDriver = $state<"ollama" | "vllm" | null>(null);
  let replicas = $state(1);
  let customCodeConsent = $state(false);
  let shouldAutoSelectCanary = $state(true);

  // --- Edit mode tracking ---
  type Snapshot = {
    name: string; publicSpecifier: string; enabled: boolean;
    earlySpecifier: string | null; progress: number;
    canaryProgressWithFeedback: boolean;
    preferredDriver: string | null; replicas: number; kvCacheSize: number | null;
    earlyKvCacheSize: number | null; settings: DeploymentSettings;
  };
  let initialSnapshot = $state<Snapshot | null>(null);
  let lastInitDeploymentId = $state<string | undefined>(undefined);

  // --- Fetched model state ---
  let selectedPrimaryModel = $state<ModelWithSpecifier | null>(null);
  let selectedCanaryModel = $state<ModelWithSpecifier | null>(null);

  // --- Helpers ---
  const primaryFetchGen = { v: 0 };
  const canaryFetchGen = { v: 0 };
  const canaryAutoSelectGen = { v: 0 };

  function fetchModel(specifier: string | null, set: (m: ModelWithSpecifier | null) => void, gen: { v: number }) {
    const seq = ++gen.v;
    if (!specifier) { set(null); return; }
    orpc.model.get({ specifier }).then(([error, data]) => {
      if (seq !== gen.v) return;
      if (error) { toastState.add(`Failed to load model info: ${error.message}`, "error"); return; }
      set(data ?? null);
    });
  }

  function deriveAdvancementStrategy(d: DeploymentDefinition) {
    if (!d.earlySpecifier) return "manual" as const;
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
    selectedPrimarySpecifier = d.specifier;
    selectedCanarySpecifier = d.earlySpecifier ?? null;
    isCanaryEnabled = Boolean(d.earlySpecifier);
    canaryTraffic = d.progress ?? 100;
    kvCacheSize = d.kvCacheSize ?? null;
    earlyKvCacheSize = d.earlyKvCacheSize ?? null;
    settings = { ...d.settings ?? { version: 1 } };
    preferredDriver = d.preferredDriver ?? null;
    replicas = d.replicas;
    customCodeConsent = false;
    shouldAutoSelectCanary = true;
    advancementStrategy = deriveAdvancementStrategy(d);
    if (advancementStrategy === "time-based" && d.canaryProgressUntil) {
      const from = d.canaryProgressFrom ?? new Date();
      timeBasedDurationHours = Math.max(1, Math.round((d.canaryProgressUntil.getTime() - from.getTime()) / 3_600_000));
    }

    initialSnapshot = {
      name: d.name, publicSpecifier: d.publicSpecifier, enabled: d.enabled,
      earlySpecifier: d.earlySpecifier ?? null, progress: d.progress,
      canaryProgressWithFeedback: d.canaryProgressWithFeedback,
      preferredDriver: d.preferredDriver ?? null, replicas: d.replicas,
      kvCacheSize: d.kvCacheSize ?? null, earlyKvCacheSize: d.earlyKvCacheSize ?? null,
      settings: { ...d.settings ?? { version: 1 } },
    };
  });

  $effect(() => {
    if (!deployment) { lastInitDeploymentId = undefined; initialSnapshot = null; }
  });

  // --- Model fetching ---
  $effect(() => fetchModel(selectedPrimarySpecifier, m => selectedPrimaryModel = m, primaryFetchGen));
  $effect(() => fetchModel(selectedCanarySpecifier, m => selectedCanaryModel = m, canaryFetchGen));

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

  const showTrafficSlider = $derived(!isEditMode || advancementStrategy === "manual");
  const requiresDisabled = $derived(isEditMode && enabled);

  // --- Capacity gate ---
  // Capacity is only enforced when the resulting deployment would be enabled and is
  // not already accounted for: that means create mode (enabled), or re-enabling a
  // currently-disabled deployment. An already-enabled deployment is skipped so its
  // own running installations are not double-counted against it.
  const shouldGateCapacity = $derived(Boolean(
    selectedPrimaryModel && enabled && (!isEditMode || (deployment && !deployment.enabled)),
  ));

  let capacityChecked = $state(false);
  let capacityBlocked = $state(false);
  let capacityReason = $state<string | undefined>(undefined);

  $effect(() => {
    if (!shouldGateCapacity || !selectedPrimarySpecifier) {
      capacityChecked = false; capacityBlocked = false; capacityReason = undefined; return;
    }
    const abort = new AbortController();
    orpc.deployment.checkCapacity({
      specifier: selectedPrimarySpecifier,
      earlySpecifier: isCanaryEnabled ? selectedCanarySpecifier : null,
      replicas, progress: isCanaryEnabled ? canaryTraffic : 100, kvCacheSize,
      earlyKvCacheSize: isCanaryEnabled ? earlyKvCacheSize : null,
      preferredDriver,
    }, { signal: abort.signal }).then(([error, data]) => {
      if (abort.signal.aborted) return;
      if (error) { browserLogger.error({ error }, "Capacity check failed"); capacityChecked = false; capacityBlocked = false; return; }
      capacityChecked = true;
      capacityBlocked = !data.deployable;
      capacityReason = data.reason;
    });
    return () => abort.abort();
  });

  /** Only asked for on a change: an unchanged deployment was already consented to. */
  const requiresCustomCodeConsent = $derived.by(() => {
    if (!selectedPrimaryModel?.tags.includes("custom_code")) return false;
    return !isEditMode || selectedPrimarySpecifier !== deployment?.specifier;
  });

  const isFormValid = $derived(Boolean(
    selectedPrimaryModel && deploymentName.trim() && publicSpecifier.trim() &&
    (!isCanaryEnabled || (selectedCanaryModel && !canaryTypeMismatch)) &&
    (kvCacheSize === null || kvCacheSize >= minKvCache) &&
    (!isCanaryEnabled || earlyKvCacheSize === null || earlyKvCacheSize >= minCanaryKvCache) &&
    (!requiresCustomCodeConsent || customCodeConsent) &&
    DeploymentSettingsDto.safeParse(settings).success &&
    !capacityBlocked && replicas >= 1,
  ));

  const hasChanges = $derived.by(() => {
    if (!isEditMode || !initialSnapshot) return true;
    const s = initialSnapshot;
    return (
      deploymentName.trim() !== s.name.trim() ||
      publicSpecifier.trim() !== s.publicSpecifier.trim() ||
      enabled !== s.enabled ||
      (isCanaryEnabled ? (selectedCanarySpecifier ?? null) : null) !== s.earlySpecifier ||
      (isCanaryEnabled ? canaryTraffic : 100) !== s.progress ||
      (isCanaryEnabled && advancementStrategy === "smart-auto") !== s.canaryProgressWithFeedback ||
      (preferredDriver ?? null) !== s.preferredDriver ||
      replicas !== s.replicas ||
      (kvCacheSize ?? null) !== s.kvCacheSize ||
      (earlyKvCacheSize ?? null) !== s.earlyKvCacheSize ||
      !settingsEqual(settings, s.settings)
    );
  });

  function suggestedPublicSpecifier(model: ModelWithSpecifier | null | undefined): string {
    if (!model) {
      return "";
    }
    const engineSuffix = `-${model.engine}`;
    if (!model.publicSpecifier.endsWith(engineSuffix)) {
      return model.publicSpecifier;
    }
    return model.publicSpecifier.slice(0, -engineSuffix.length);
  }

  // --- Create-mode effects ---
  $effect(() => {
    if (isEditMode) return;
    const model = selectedPrimaryModel;
    if (!publicSpecifierEdited) {
      publicSpecifier = suggestedPublicSpecifier(model);
    }
    if (!deploymentNameEdited) deploymentName = model?.name || "";
  });

  $effect(() => { if (!isEditMode) kvCacheSize = selectedPrimaryModel?.minKvCache ?? null; });
  $effect(() => { if (!isEditMode) earlyKvCacheSize = selectedCanaryModel?.minKvCache ?? null; });

  $effect(() => { if (!isEditMode) { selectedPrimarySpecifier; customCodeConsent = false; } });

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
    }, canaryAutoSelectGen);
  });

  // Edit mode: clear canary when disabled
  $effect(() => { if (isEditMode && !isCanaryEnabled) selectedCanarySpecifier = null; });

  // --- Submit ---
  async function handleSubmit() {
    if (!isFormValid || !selectedPrimaryModel) return;

    const primarySpecifier = selectedPrimaryModel.publicSpecifier;
    const earlySpecifier = isCanaryEnabled && selectedCanaryModel ? selectedCanaryModel.publicSpecifier : null;
    // Ollama has no KV-cache knob; clear any value carried over from a different driver
    const engine = selectedPrimaryModel.engine;
    const submittedKvCacheSize = engine === "ollama" ? null : kvCacheSize;
    const submittedEarlyKvCacheSize = engine === "ollama" ? null : earlyKvCacheSize;
    // Audio settings only apply to transcription models; drop stale values on model change
    const submittedSettings: DeploymentSettings = { version: 1 };
    if (selectedPrimaryModel.type === "transcription" && settings.maxAudioInputDurationS != null) {
      submittedSettings.maxAudioInputDurationS = Math.round(settings.maxAudioInputDurationS);
    }

    const [error] = deployment
      ? await orpc.deployment.update({
          ...deployment,
          name: deploymentName.trim(),
          publicSpecifier: publicSpecifier.trim(),
          enabled,
          specifier: primarySpecifier,
          earlySpecifier: isCanaryEnabled ? (selectedCanarySpecifier ?? null) : null,
          progress: isCanaryEnabled ? canaryTraffic : 100,
          canaryProgressWithFeedback: isCanaryEnabled && advancementStrategy === "smart-auto",
          canaryProgressFrom: isCanaryEnabled && advancementStrategy !== "manual"
            ? (deployment.canaryProgressFrom ?? new Date()) : null,
          canaryProgressUntil: isCanaryEnabled && advancementStrategy === "time-based"
            ? new Date(Date.now() + timeBasedDurationHours * 3_600_000) : null,
          kvCacheSize: submittedKvCacheSize,
          earlyKvCacheSize: isCanaryEnabled ? submittedEarlyKvCacheSize : null,
          preferredDriver: preferredDriver || null, replicas,
          settings: submittedSettings,
        })
      : await orpc.deployment.create({
          enabled, name: deploymentName.trim(), publicSpecifier: publicSpecifier.trim(),
          specifier: primarySpecifier,
          earlySpecifier: earlySpecifier ?? undefined,
          replicas, canaryProgressWithFeedback: advancementStrategy === "smart-auto",
          kvCacheSize: submittedKvCacheSize && submittedKvCacheSize > minKvCache ? submittedKvCacheSize : undefined,
          earlyKvCacheSize: isCanaryEnabled && selectedCanaryModel && submittedEarlyKvCacheSize && submittedEarlyKvCacheSize > minCanaryKvCache ? submittedEarlyKvCacheSize : undefined,
          preferredDriver: preferredDriver || null,
          progress: isCanaryEnabled && selectedCanaryModel ? canaryTraffic : undefined,
          canaryProgressFrom: isCanaryEnabled && selectedCanaryModel ? new Date() : undefined,
          canaryProgressUntil: isCanaryEnabled && selectedCanaryModel && advancementStrategy === "time-based"
            ? new Date(Date.now() + timeBasedDurationHours * 3_600_000) : undefined,
          settings: submittedSettings,
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
    kvCacheSize = null; earlyKvCacheSize = null; settings = { version: 1 }; preferredDriver = null; replicas = 1;
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
          {nodeCapabilities}
          {maxReplicas}
          {enabled}
          {capacityChecked}
          {capacityBlocked}
          {capacityReason}
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
          bind:settings
          {maxKvCache}
          {maxCanaryKvCache}
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
        <div class="flex flex-col gap-1 min-w-0">
          <label
            for="enabled{idSuffix}"
            class="flex items-center gap-2 py-1.5 px-1 -ml-1 rounded select-none cursor-pointer"
          >
            <Checkbox id="enabled{idSuffix}" bind:checked={enabled} />
            <span class="text-sm">
              {isEditMode ? "Enabled" : "Start deployment in enabled state"}
            </span>
          </label>
          {#if enabled && capacityBlocked}
            <span class="text-sm text-destructive px-1">
              {capacityReason ?? "This deployment needs more capacity than is currently available"}.
              <br>
              Uncheck "{isEditMode ? "Enabled" : "Start deployment in enabled state"}" to save it disabled.
            </span>
          {/if}
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <Button variant="outline" onclick={close}>Cancel</Button>
          <Button onclick={handleSubmit} disabled={!isFormValid || (isEditMode && !hasChanges)}>
            {isEditMode ? "Save" : "Deploy Model"}
          </Button>
        </div>
      </footer>
    </div>
  {/if}
</Modal>
