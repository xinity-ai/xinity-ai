<script lang="ts">
  import { ArrowRight, X } from "@lucide/svelte";
  import type { ModelWithSpecifier } from "common-env/model-catalog";
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button";
  import { orpc } from "$lib/orpc/orpc-client";
  import { toastState } from "$lib/state/toast.svelte";
  import { MIN_CANARY_REPLICAS } from "$lib/orpc/dtos/model.dto";
  import type { DeploymentOf } from "$lib/orpc/dtos/model.dto";
  import AdvanceInput from "./AdvanceInput.svelte";
  import { Input } from "$lib/components/ui/input";
  import { capacityPreview, type CapacityRequest } from "$lib/components/deployments/sections/capacity-preview.svelte";
  import CustomCodeConsent from "$lib/components/deployments/picker/CustomCodeConsent.svelte";
  import DeploymentCapacitySummary from "$lib/components/deployments/sections/DeploymentCapacitySummary.svelte";
  import type { PanelContext } from "./deployment-views";
  import LicenseNotice from "$lib/components/deployments/picker/LicenseNotice.svelte";
  import { advanceInputOf, type AdvanceDraft } from "$lib/components/deployments/rollout-advance";

  let {
    deployment,
    target,
    context,
    close,
    chooseAnother,
  }: {
    deployment: DeploymentOf<"managed">;
    target: ModelWithSpecifier;
    context: PanelContext;
    close: () => void;
    chooseAnother: () => void;
  } = $props();

  type Way = "gradual" | "switch";

  // Downloading and loading weights of this size takes minutes rather than seconds.
  const LARGE_MODEL_GB = 30;

  let way = $state<Way>("gradual");
  let startShare = $state(10);
  let advance = $state<AdvanceDraft>({ type: "manual" });
  let advanceInvalid = $state(false);
  let licenseConsent = $state(false);
  let customCodeConsent = $state(false);
  let submitting = $state(false);
  let error = $state<string | null>(null);

  const current = $derived(context.models.get(deployment.managed.specifier));
  const rolloutReplicas = $derived(Math.max(MIN_CANARY_REPLICAS, deployment.managed.replicas));
  const restrictedLicense = $derived(target.license.use === "open" ? [] : [target.license]);
  const needsCustomCodeConsent = $derived(target.tags.includes("custom_code"));

  const WAYS: Record<Way, {
    submit: string;
    request: () => Parameters<typeof orpc.deployments.rollout>[0];
    capacity: () => CapacityRequest;
    done: () => string;
  }> = {
    gradual: {
      submit: "Start rollout",
      capacity: () => {
        const { specifier, kvCacheSize, preferredDriver, settings } = deployment.managed;
        return {
          type: "canary",
          deploymentId: deployment.id,
          canary: { replicas: rolloutReplicas, progress: startShare, from: { specifier, kvCacheSize, preferredDriver, settings }, to: { specifier: target.publicSpecifier } },
        };
      },
      request: () => ({
        id: deployment.id,
        type: "canary",
        canary: { to: { specifier: target.publicSpecifier }, progress: startShare, advance: advanceInputOf(advance) },
      }),
      done: () => `Rolling out ${target.name}`,
    },
    switch: {
      submit: "Switch model",
      capacity: () => ({
        type: "managed",
        deploymentId: deployment.id,
        managed: { ...deployment.managed, specifier: target.publicSpecifier, kvCacheSize: null },
      }),
      request: () => ({ id: deployment.id, type: "managed", managed: { to: { specifier: target.publicSpecifier } } }),
      done: () => `Switched to ${target.name}`,
    },
  };

  const shareError = $derived(way === "gradual" && !(Number.isInteger(startShare) && startShare >= 0 && startShare <= 100) ? "Give a whole number from 0 to 100." : null);
  const preview = capacityPreview(() => (shareError ? null : WAYS[way].capacity()), () => deployment.enabled);

  const ready = $derived(
    (restrictedLicense.length === 0 || licenseConsent) && (!needsCustomCodeConsent || customCodeConsent) && !submitting && !preview.refused && !shareError && !(way === "gradual" && advanceInvalid),
  );

  async function submit() {
    submitting = true;
    error = null;
    const [err] = await orpc.deployments.rollout(WAYS[way].request());
    submitting = false;
    if (err) {
      error = err.message;
      return;
    }
    toastState.add(WAYS[way].done(), "success");
    close();
    await context.onChanged();
  }
</script>

<Modal open={true} onClose={close} class="z-40">
  <div class="bg-card rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
    <header class="p-5 border-b flex justify-between items-center">
      <h2 class="text-xl font-semibold">Change model</h2>
      <Button variant="ghost" size="icon" onclick={close} aria-label="Close">
        <X class="w-5 h-5" />
      </Button>
    </header>

    <div class="p-5 grow overflow-y-auto space-y-5">
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <span class="font-medium">{current?.name ?? deployment.managed.specifier}</span>
        <ArrowRight class="w-4 h-4 text-muted-foreground" aria-label="to" />
        <span class="font-medium">{target.name}</span>
        <Button variant="link" size="sm" class="h-auto p-0" onclick={chooseAnother}>Choose another model</Button>
      </div>

      <div class="space-y-3" role="radiogroup">
        <label class="block cursor-pointer rounded-lg border p-4 has-checked:border-primary has-checked:bg-primary/5">
          <span class="flex items-center gap-2 font-medium">
            <input type="radio" name="change-way" value="gradual" bind:group={way} />
            Roll out gradually
          </span>
          <span class="mt-1 block text-sm text-muted-foreground">
              Both models run side by side, each on replicas of its own, and traffic is split between them. Callers keep being served throughout.
              {#if rolloutReplicas > deployment.managed.replicas}
                The rollout runs on {rolloutReplicas} replicas, one per model, and the deployment keeps that count afterwards.
              {/if}
              You promote the new model when you are satisfied, or roll back.
          </span>
        </label>
        {#if way === "gradual"}
          <div class="space-y-4 rounded-lg bg-muted/40 p-4">
            <div class="space-y-1.5">
              <label for="start-share" class="text-sm font-medium">Start with <span class="text-primary">{startShare}%</span> of traffic on {target.name}</label>
              <div class="flex items-center gap-3">
                <input id="start-share" type="range" min="0" max="100" step="1" bind:value={startShare} class="w-full accent-primary cursor-pointer" />
                <Input type="number" min={0} max={100} step="1" bind:value={startShare} class="h-8 w-20 shrink-0" aria-label="Starting share in percent" aria-invalid={Boolean(shareError)} />
              </div>
              {#if shareError}
                <p class="text-xs text-destructive">{shareError}</p>
              {/if}
            </div>
            <div class="space-y-1.5">
              <p class="text-sm font-medium">Then move traffic</p>
              <AdvanceInput bind:advance bind:invalid={advanceInvalid} idSuffix="-change" />
            </div>
          </div>
        {/if}

        <label class="block cursor-pointer rounded-lg border p-4 has-checked:border-primary has-checked:bg-primary/5">
          <span class="flex items-center gap-2 font-medium">
            <input type="radio" name="change-way" value="switch" bind:group={way} />
            Switch now
          </span>
          <span class="mt-1 block text-sm text-muted-foreground">
            Serving stops until {target.name} is installed{target.sizing.weightGb >= LARGE_MODEL_GB ? ", which can take a while for a model this large" : ""}.
            {current?.name ?? deployment.managed.specifier} is uninstalled and removed from the deployment.
          </span>
        </label>
      </div>

      {#if !shareError}
        <DeploymentCapacitySummary capacity={preview.result} refused={preview.refused} nodeCapabilities={context.nodeCapabilities} enabled={deployment.enabled} />
      {/if}

      {#if restrictedLicense.length > 0}
        <LicenseNotice licenses={restrictedLicense} bind:consented={licenseConsent} idSuffix="-change" />
      {/if}
      {#if needsCustomCodeConsent}
        <CustomCodeConsent bind:consented={customCodeConsent} idSuffix="-change" />
      {/if}
    </div>

    <footer class="p-5 border-t bg-muted/50 rounded-b-xl flex flex-wrap items-center justify-end gap-3">
      {#if error}
        <p class="mr-auto text-sm text-destructive">{error}</p>
      {:else if preview.refused}
        <p class="mr-auto text-sm text-destructive">{preview.result?.reason ?? "It does not fit now"}.</p>
      {/if}
      <Button variant="outline" onclick={close}>Cancel</Button>
      <Button variant={way === "switch" ? "destructive" : "default"} onclick={submit} disabled={!ready}>{WAYS[way].submit}</Button>
    </footer>
  </div>
</Modal>
