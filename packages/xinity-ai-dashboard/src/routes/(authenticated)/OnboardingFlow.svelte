<script lang="ts">
  import { orpc } from "$lib/orpc/orpc-client";
  import { organization } from "$lib/auth";
  import { goto, invalidateAll } from "$app/navigation";
  import { copyToClipboard } from "$lib/copy";
  import type { ModelWithSpecifier } from "xinity-infoserver";

  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";

  import { Rocket, Copy, CheckCircle2, XCircle, Loader2, X } from "@lucide/svelte";
  import ModelSelectorModal from "./modelhub/ModelSelectorModal.svelte";

  let orgName = $state("");
  let selectedModel = $state<ModelWithSpecifier | null>(null);
  let modelSelectorOpen = $state(false);
  let isSubmitting = $state(false);
  let error = $state("");
  let result = $state<{ apiKey: string } | null>(null);
  let slugAvailable = $state<boolean | null>(null);
  let checkingSlug = $state(false);

  // Auto-generate slug from org name
  const slug = $derived(
    orgName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  );

  // Debounced slug availability check
  let slugCheckTimeout: ReturnType<typeof setTimeout>;
  $effect(() => {
    if (!slug || slug.length < 2) {
      slugAvailable = null;
      return;
    }

    checkingSlug = true;
    clearTimeout(slugCheckTimeout);

    slugCheckTimeout = setTimeout(async () => {
      const result = await organization.checkSlug({ slug });
      if (result.data) {
        slugAvailable = result.data.status;
      }
      checkingSlug = false;
    }, 500);
  });

  const canSubmit = $derived(orgName.trim().length > 0 && selectedModel && slugAvailable !== false && !isSubmitting);

  async function handleOnboard() {
    if (!selectedModel) return;

    if (slugAvailable === false) {
      error = "This organization name results in a slug that is already taken. Please choose a different name.";
      return;
    }

    isSubmitting = true;
    error = "";

    const { error: setupError, data } = await orpc.onboarding.setup({
      orgName,
      specifier: selectedModel.publicSpecifier,
      modelSpecifier: Object.values(selectedModel.providers)[0] ?? selectedModel.publicSpecifier,
      publicSpecifier: selectedModel.publicSpecifier,
    });

    if (setupError) {
      error = setupError.message || "Failed to complete setup";
      isSubmitting = false;
      return;
    }

    result = { apiKey: data.apiKey };
    isSubmitting = false;
  }

</script>

<div class="flex items-center justify-center min-h-[80vh] px-4">
  <div class="w-full max-w-xl">
    {#if result}
      <!-- Success -->
      <Card.Root>
        <Card.Header class="text-center">
          <div class="mx-auto mb-3 flex items-center justify-center w-14 h-14 rounded-full bg-green-100">
            <CheckCircle2 class="w-7 h-7 text-green-600" />
          </div>
          <Card.Title class="text-2xl">You're all set!</Card.Title>
          <Card.Description>
            Your organization, API key, and model deployment have been created.
          </Card.Description>
        </Card.Header>
        <Card.Content class="space-y-4">
          <div class="space-y-2">
            <Label>Your API Key</Label>
            <div class="flex items-center gap-2">
              <Input
                type="text"
                value={result.apiKey}
                readonly
                class="font-mono text-sm"
              />
              <Button
                variant="outline"
                size="icon"
                onclick={() => copyToClipboard(result!.apiKey)}
                title="Copy API key"
              >
                <Copy class="w-4 h-4" />
              </Button>
            </div>
            <p class="text-xs text-muted-foreground">
              Copy this key now. You won't be able to see the full key again.
            </p>
            <p class="text-xs text-muted-foreground">
              To get started, check out the documentation where you'll find guides on how to use your API key.
            </p>
          </div>
          <Button onclick={()=> {
            goto("/docs/quick-start/", {invalidateAll: true})
          }} class="w-full">Check out the Documentation</Button>
        </Card.Content>
      </Card.Root>
    {:else}
      <!-- Onboarding Form -->
      <Card.Root>
        <Card.Header class="text-center">
          <div class="mx-auto mb-3 flex items-center justify-center w-14 h-14 rounded-full bg-xinity-purple/15">
            <Rocket class="w-7 h-7 text-xinity-magenta" />
          </div>
          <Card.Title class="text-2xl">Welcome to Xinity AI</Card.Title>
          <Card.Description>
            Set up your organization and deploy your first model in one step.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <form
            onsubmit={(e) => { e.preventDefault(); handleOnboard(); }}
            class="space-y-6"
          >
            {#if error}
              <div class="p-3 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg">
                {error}
              </div>
            {/if}

            <div class="space-y-2">
              <Label for="orgName">Organization Name</Label>
              <Input
                id="orgName"
                bind:value={orgName}
                placeholder="My Company"
                required
              />
              {#if slug}
                <div class="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Slug: <span class="font-mono">{slug}</span></span>
                  {#if checkingSlug}
                    <Loader2 class="w-3 h-3 animate-spin" />
                  {:else if slugAvailable === true}
                    <CheckCircle2 class="w-3 h-3 text-green-500" />
                  {:else if slugAvailable === false}
                    <XCircle class="w-3 h-3 text-destructive" />
                    <span class="text-destructive">This name is already taken</span>
                  {/if}
                </div>
              {:else}
                <p class="text-xs text-muted-foreground">
                  This is the workspace where your team manages models and API keys.
                </p>
              {/if}
            </div>

            <div class="space-y-2">
              <Label>Select a Model to Deploy</Label>
              {#if selectedModel}
                <div class="flex items-center gap-3 p-3 border rounded-lg bg-primary/5 border-primary">
                  <div class="flex-1 min-w-0">
                    <p class="font-medium text-sm">{selectedModel.name}</p>
                    <p class="text-xs text-muted-foreground font-mono">{selectedModel.publicSpecifier}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onclick={() => (selectedModel = null)}
                  >
                    <X class="w-4 h-4" />
                  </Button>
                </div>
                <Button
                  type="button"
                  variant="link"
                  class="px-0 h-auto text-xs"
                  onclick={() => (modelSelectorOpen = true)}
                >
                  Change model
                </Button>
              {:else}
                <Button
                  type="button"
                  variant="outline"
                  class="w-full justify-start text-muted-foreground"
                  onclick={() => (modelSelectorOpen = true)}
                >
                  Browse models...
                </Button>
              {/if}
            </div>

            <Button type="submit" disabled={!canSubmit} class="w-full">
              {#if isSubmitting}
                <Loader2 class="w-4 h-4 animate-spin" />
                Setting up...
              {:else}
                Get Started
              {/if}
            </Button>
          </form>
        </Card.Content>
      </Card.Root>
    {/if}
  </div>
</div>

<ModelSelectorModal
  bind:open={modelSelectorOpen}
  onSelect={(model) => (selectedModel = model)}
  onClose={() => (modelSelectorOpen = false)}
/>
