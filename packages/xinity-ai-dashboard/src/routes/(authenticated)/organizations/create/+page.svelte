<script lang="ts">
  import { goto } from "$app/navigation";
  import { organization } from "$lib/auth";
  import { orpc } from "$lib/orpc/orpc-client";

  // shadcn components
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Alert from "$lib/components/ui/alert";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";

  // Icons
  import { ArrowLeft, Loader2, CheckCircle2, XCircle } from "@lucide/svelte";

  let name = $state("");
  let slug = $state("");
  let logo = $state("");
  let isSubmitting = $state(false);
  let error = $state("");
  let slugAvailable = $state<boolean | null>(null);
  let checkingSlug = $state(false);
  let slugNotYetEdited = $state(true);

  // Auto-generate slug from name
  $effect(() => {
    if (slugNotYetEdited) {
      slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    }
  });

  // Debounced slug availability check
  let slugCheckTimeout: ReturnType<typeof setTimeout>;
  async function checkSlugAvailability() {
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
  }

  $effect(() => {
    if (slug) {
      checkSlugAvailability();
    }
  });

  async function handleSubmit(e: Event) {
    e.preventDefault();

    if (!name || !slug) {
      error = "Name and slug are required";
      return;
    }

    if (slugAvailable === false) {
      error = "This slug is already taken";
      return;
    }

    isSubmitting = true;
    error = "";

    const { error: createError, data } = await orpc.organization.create({
      name,
      slug,
      logo: logo || undefined,
    });

    if (createError) {
      error = createError.message || "Failed to create organization";
      isSubmitting = false;
    } else if (data) {
      goto(`/organizations/${slug}`, { invalidateAll: true });
    }
  }

  const canSubmit = $derived(name && slug && slugAvailable !== false && !isSubmitting);
</script>

<svelte:head>
  <title>Create Organization</title>
</svelte:head>

<div class="container max-w-2xl px-6 py-8 mx-auto">
  <div class="mb-6">
    <Button variant="ghost" href="/organizations" class="mb-4 -ml-2">
      <ArrowLeft class="w-4 h-4" />
      Back to Organizations
    </Button>

    <h1 class="text-2xl font-semibold tracking-tight">Create Organization</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      Create a new organization to collaborate with your team.
    </p>
  </div>

  <Card.Root>
    <Card.Content class="pt-6">
      <form onsubmit={handleSubmit} class="space-y-6">
        {#if error}
          <Alert.Root variant="destructive">
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}

        <div class="space-y-2">
          <Label for="name">
            Organization Name <span class="text-destructive">*</span>
          </Label>
          <Input
            type="text"
            id="name"
            bind:value={name}
            required
            placeholder="Acme Inc."
          />
        </div>

        <div class="space-y-2">
          <Label for="slug">
            Organization Slug <span class="text-destructive">*</span>
          </Label>
          <div class="relative">
            <div class="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
              <span class="text-muted-foreground">/</span>
            </div>
            <Input
              type="text"
              id="slug"
              bind:value={slug}
              oninput={() => (slugNotYetEdited = false)}
              required
              pattern="[a-z0-9-]+"
              class="pl-7 pr-10"
              placeholder="acme-inc"
            />
            <div class="absolute inset-y-0 right-0 flex items-center pr-3">
              {#if checkingSlug}
                <Loader2 class="w-4 h-4 text-muted-foreground animate-spin" />
              {:else if slugAvailable === true}
                <CheckCircle2 class="w-4 h-4 text-green-500" />
              {:else if slugAvailable === false}
                <XCircle class="w-4 h-4 text-destructive" />
              {/if}
            </div>
          </div>
          <p class="text-xs text-muted-foreground">
            Only lowercase letters, numbers, and hyphens. This will be used in URLs.
          </p>
        </div>

        <div class="space-y-2">
          <Label for="logo">Logo URL (optional)</Label>
          <Input
            type="url"
            id="logo"
            bind:value={logo}
            placeholder="https://example.com/logo.png"
          />
        </div>

        <div class="flex gap-3 pt-2">
          <Button type="submit" disabled={!canSubmit} class="flex-1">
            {#if isSubmitting}
              <Loader2 class="w-4 h-4 animate-spin" />
              Creating...
            {:else}
              Create Organization
            {/if}
          </Button>
          <Button variant="outline" href="/organizations">
            Cancel
          </Button>
        </div>
      </form>
    </Card.Content>
  </Card.Root>
</div>
