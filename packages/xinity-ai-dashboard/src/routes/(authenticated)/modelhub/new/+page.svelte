<script lang="ts">
  import { ArrowLeft, Rocket } from "@lucide/svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { ModelWithSpecifier } from "common-env/model-catalog";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { orpc } from "$lib/orpc/orpc-client";
  import { toastState } from "$lib/state/toast.svelte";
  import { permissions } from "$lib/state/permissions.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import NoOrganization from "$lib/components/NoOrganization.svelte";
  import type { PageData } from "./$types";
  import type { DeploymentOf } from "$lib/orpc/dtos/model.dto";
  import CustomCodeConsent from "$lib/components/deployments/picker/CustomCodeConsent.svelte";
  import { sectionsOf, type SectionContext, type SectionDraft } from "$lib/components/deployments/sections/deployment-sections";
  import LicenseNotice from "$lib/components/deployments/picker/LicenseNotice.svelte";
  import ModelCard from "$lib/components/deployments/picker/ModelCard.svelte";
  import ModelSelector from "$lib/components/deployments/picker/ModelSelector.svelte";
  import PanelCard from "$lib/components/deployments/PanelCard.svelte";

  let { data }: { data: PageData } = $props();

  const models = new SvelteMap<string, ModelWithSpecifier | null>();
  let draft = $state<DeploymentOf<"managed"> | null>(null);
  let licenseConsent = $state(false);
  let customCodeConsent = $state(false);
  let deploying = $state(false);
  let takenPublicSpecifiers = $state<string[]>([]);
  let error = $state<string | null>(null);

  function suggestedPublicSpecifier(model: ModelWithSpecifier, taken: string[]): string {
    const engineSuffix = `-${model.engine}`;
    const base = model.publicSpecifier.endsWith(engineSuffix) ? model.publicSpecifier.slice(0, -engineSuffix.length) : model.publicSpecifier;
    let candidate = base;
    for (let number = 2; taken.includes(candidate); number++) {
      candidate = `${base}-${number}`;
    }
    return candidate;
  }

  function draftFor(model: ModelWithSpecifier): DeploymentOf<"managed"> {
    const now = new Date();
    return {
      id: "",
      type: "managed",
      name: model.name,
      publicSpecifier: suggestedPublicSpecifier(model, takenPublicSpecifiers),
      description: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managed: { specifier: model.publicSpecifier, replicas: 1, kvCacheSize: null, preferredDriver: null, settings: { version: 1 } },
    };
  }

  $effect(() => {
    void orpc.deployments.list({ withStatus: false }).then(([err, deployments]) => {
      if (!err) {
        takenPublicSpecifiers = deployments.map((deployment) => deployment.publicSpecifier);
      }
    });
  });

  // The chosen model lives in the URL, so back returns to the picker and a reload keeps the step.
  $effect(() => {
    const specifier = page.url.searchParams.get("model");
    draft = null;
    error = null;
    licenseConsent = false;
    customCodeConsent = false;
    if (!specifier) {
      return;
    }
    let current = true;
    void orpc.model.get({ specifier }).then(([err, model]) => {
      if (!current) {
        return;
      }
      if (err || !model) {
        toastState.add(`The catalog has no model "${specifier}"`, "error");
        void goto("/modelhub/new");
        return;
      }
      models.set(specifier, model);
      draft = draftFor(model);
    });
    return () => {
      current = false;
    };
  });

  const chosen = $derived(draft ? models.get(draft.managed.specifier) ?? null : null);
  const restrictedLicenses = $derived(chosen && chosen.license.use !== "open" ? [chosen.license] : []);
  const needsCustomCodeConsent = $derived(Boolean(chosen?.tags.includes("custom_code")));

  const sectionContext = $derived<SectionContext>({
    creating: true,
    enabled: draft?.enabled ?? true,
    models,
    nodeCapabilities: data.cluster.nodeCapabilities,
    modelCompatibility: data.cluster.modelCompatibility,
    canEdit: true,
    takenPublicSpecifiers,
    licensedVram: data.cluster.licensedVram,
  });

  const blockedSections = $state<Record<string, boolean>>({});
  const blocked = $derived(Object.values(blockedSections).some(Boolean));

  const ready = $derived(Boolean(
    draft && !blocked
    && (restrictedLicenses.length === 0 || licenseConsent)
    && (!needsCustomCodeConsent || customCodeConsent),
  ));

  async function deploy() {
    if (!draft) {
      return;
    }
    deploying = true;
    error = null;
    const { name, publicSpecifier, enabled, managed } = $state.snapshot(draft);
    const [err, created] = await orpc.deployments.create({ type: "managed", name, publicSpecifier, enabled, managed });
    deploying = false;
    if (err) {
      error = err.message;
      return;
    }
    toastState.add(created.enabled ? `Deploying "${created.name}"` : `Saved "${created.name}", disabled`, "success");
    await goto(`/modelhub/${created.id}`);
  }
</script>

<svelte:head>
  <title>Deploy a model - Model Hub - Xinity Admin Dashboard</title>
</svelte:head>

{#if !data.activeOrganizationId}
  <NoOrganization />
{:else if !permissions.canManageDeployments}
  <p class="p-6 text-muted-foreground">Contact an organization admin to deploy a model.</p>
{:else}
  <div class="p-6 compact:p-3 space-y-5 compact:space-y-3">
    <a href="/modelhub/" class="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft class="w-4 h-4" />
      Model Hub
    </a>

    <header class="space-y-1">
      <h1 class="text-2xl font-bold">Deploy a model</h1>
      <ol class="flex items-center gap-2 text-sm text-muted-foreground">
        <li class={page.url.searchParams.has("model") ? "" : "font-medium text-foreground"}>1. Choose a model</li>
        <li aria-hidden="true">›</li>
        <li class={page.url.searchParams.has("model") ? "font-medium text-foreground" : ""}>2. Set it up</li>
      </ol>
    </header>

    {#if !page.url.searchParams.has("model")}
      <div class="h-[calc(100vh-14rem)] min-h-[32rem] overflow-hidden rounded-xl border bg-card">
        <ModelSelector
          nodeCapabilities={data.cluster.nodeCapabilities}
          modelCompatibility={data.cluster.modelCompatibility}
          licensedVram={data.cluster.licensedVram}
          onSelect={(model) => goto(`/modelhub/new?model=${encodeURIComponent(model.publicSpecifier)}`)}
        />
      </div>
    {:else if !draft}
      <div class="h-40 rounded-xl border bg-card animate-pulse"></div>
    {:else}
      {@const editable = sectionsOf(draft, sectionContext)}
      <div class="grid grid-cols-[minmax(0,1fr)] gap-5 compact:gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start">
        <div class="space-y-5 compact:space-y-3">
          <PanelCard title="Model">
            {#snippet actions()}
              <Button variant="ghost" size="sm" class="h-7" href="/modelhub/new">Choose another</Button>
            {/snippet}
            <ModelCard specifier={draft.managed.specifier} model={chosen} />
          </PanelCard>
          {#if restrictedLicenses.length > 0}
            <LicenseNotice licenses={restrictedLicenses} bind:consented={licenseConsent} />
          {/if}
          {#if needsCustomCodeConsent}
            <CustomCodeConsent bind:consented={customCodeConsent} />
          {/if}
        </div>

        <div class="space-y-5 compact:space-y-3">
          {#each editable?.sections ?? [] as section (section.title)}
            {@const Section = section.component}
            <PanelCard title={section.title}>
              <Section
                bind:draft={() => draft as SectionDraft, (next) => (draft = next as DeploymentOf<"managed">)}
                bind:blocked={blockedSections[section.title]}
                context={sectionContext}
                editing={true}
                changed={true}
              />
            </PanelCard>
          {/each}

          <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
            <label class="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox bind:checked={draft.enabled} />
              Start serving right away
            </label>
            <Button onclick={deploy} disabled={!ready || deploying}>
              <Rocket class="w-4 h-4" />
              {draft.enabled ? "Deploy" : "Save disabled"}
            </Button>
            {#if draft.enabled && blocked}
              <p class="w-full text-xs text-muted-foreground">If it does not fit now, untick Start serving right away to save it disabled and enable it later.</p>
            {/if}
            {#if error}
              <p class="w-full text-sm text-destructive">{error}</p>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}
