<script lang="ts">
  import ApiKeyListing from "./ApiKeyListing.svelte";
  import ApiExamples from "./ApiExamples.svelte";
  import KeyCreateModal from "./KeyCreateModal.svelte";
  import type { PageData } from "./$types";
  import { ApiKeyDto } from "$lib/orpc/dtos/api-key.dto";
  import NoOrganization from "$lib/components/NoOrganization.svelte";

  // shadcn components
  import * as Card from "$lib/components/ui/card";

  // Icons
  import { Rocket, BookOpen, Code, Layers } from "@lucide/svelte";

  let {data} : {data: PageData} = $props();
  let applications = $derived(data.applications!);
  let apiKeys = $derived(data.apiKeys!);

  let showModal = $state(false);
  let editingKey: Pick<ApiKeyDto, "name" | "specifier" | "id" | "applicationId"> = $state({
    name: "",
    specifier: "",
    id: "",
    applicationId: null,
  });
</script>

<svelte:head>
  <title>API Keys</title>
</svelte:head>

{#if !data.activeOrganizationId}
  <NoOrganization />
{:else}
  <KeyCreateModal
    bind:editingKey
    bind:showModal
    applications={data.applications}
  />

  <div class="container px-4 py-8 compact:py-4 mx-auto">
    <h1 class="mb-8 compact:mb-4 text-3xl font-bold">API Integration</h1>

    <div class="grid grid-cols-1 gap-6 compact:gap-3 lg:grid-cols-3">
      <ApiKeyListing
        bind:showModal
        bind:editingKey
        bind:apiKeys
        {applications}
        userId={data.userId}
      />

      <ApiExamples />

      <!-- API Documentation Section -->
      <Card.Root class="lg:col-span-3">
        <Card.Header>
          <Card.Title>API Documentation</Card.Title>
          <Card.Description>
            Learn how to integrate with our API and explore available endpoints.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div class="grid grid-cols-1 gap-4 compact:gap-2 md:grid-cols-2 lg:grid-cols-4">
            <a
              href="/docs/quick-start"
              target="_blank"
              class="group block p-4 border rounded-lg transition-colors hover:bg-accent"
            >
              <div class="flex items-center gap-3 mb-2">
                <Rocket class="w-5 h-5 text-muted-foreground group-hover:text-primary" />
                <h3 class="font-semibold group-hover:text-primary">Quick Start Guide</h3>
              </div>
              <p class="text-sm text-muted-foreground">
                Get started with our API in minutes.
              </p>
            </a>
            <a
              href="/docs/applications"
              target="_blank"
              class="group block p-4 border rounded-lg transition-colors hover:bg-accent"
            >
              <div class="flex items-center gap-3 mb-2">
                <Layers class="w-5 h-5 text-muted-foreground group-hover:text-primary" />
                <h3 class="font-semibold group-hover:text-primary">Applications</h3>
              </div>
              <p class="text-sm text-muted-foreground">
                Organize calls for labeling and fine-tuning.
              </p>
            </a>
            <a
              href="/docs/api-reference"
              target="_blank"
              class="group block p-4 border rounded-lg transition-colors hover:bg-accent"
            >
              <div class="flex items-center gap-3 mb-2">
                <BookOpen class="w-5 h-5 text-muted-foreground group-hover:text-primary" />
                <h3 class="font-semibold group-hover:text-primary">API Reference</h3>
              </div>
              <p class="text-sm text-muted-foreground">
                Detailed documentation of all available endpoints.
              </p>
            </a>
            <a
              href="/docs/code-examples"
              target="_blank"
              class="group block p-4 border rounded-lg transition-colors hover:bg-accent"
            >
              <div class="flex items-center gap-3 mb-2">
                <Code class="w-5 h-5 text-muted-foreground group-hover:text-primary" />
                <h3 class="font-semibold group-hover:text-primary">Code Examples</h3>
              </div>
              <p class="text-sm text-muted-foreground">
                Sample code for common use cases.
              </p>
            </a>
          </div>
        </Card.Content>
      </Card.Root>
    </div>
  </div>
{/if}
