<script lang="ts">
  import ApiKeyListing from "./ApiKeyListing.svelte";
  import ApiExamples from "./ApiExamples.svelte";
  import KeyCreateModal from "./KeyCreateModal.svelte";
  import type { PageData } from "./$types";
  import type { ApiKeyDto } from "$lib/orpc/dtos/api-key.dto";
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

  const docLinks = [
    { href: "/docs/quick-start", icon: Rocket, title: "Quick Start Guide", description: "Get started with our API in minutes." },
    { href: "/docs/applications", icon: Layers, title: "Applications", description: "Organize calls for labeling and fine-tuning." },
    { href: "/docs/api-reference", icon: BookOpen, title: "API Reference", description: "Detailed documentation of all available endpoints." },
    { href: "/docs/code-examples", icon: Code, title: "Code Examples", description: "Sample code for common use cases." },
  ];
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
            {#each docLinks as link (link.href)}
              <a
                href={link.href}
                target="_blank"
                class="group block p-4 border rounded-lg transition-colors hover:bg-accent"
              >
                <div class="flex items-center gap-3 mb-2">
                  <link.icon class="w-5 h-5 text-muted-foreground group-hover:text-primary" />
                  <h3 class="font-semibold group-hover:text-primary">{link.title}</h3>
                </div>
                <p class="text-sm text-muted-foreground">{link.description}</p>
              </a>
            {/each}
          </div>
        </Card.Content>
      </Card.Root>
    </div>
  </div>
{/if}
