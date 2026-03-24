<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { organization } from "$lib/auth";
  import type { PageData } from "./$types";
  import InviteSection from "./InviteSection.svelte";

  // shadcn components
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Avatar from "$lib/components/ui/avatar";
  import { Badge } from "$lib/components/ui/badge";
  import * as Tooltip from "$lib/components/ui/tooltip";

  // Icons
  import { Plus, Building2 } from "@lucide/svelte";

  let { data }: { data: PageData } = $props();

  async function switchOrganization(orgId: string) {
    const result = await organization.setActive({ organizationId: orgId });
    if (result.data) {
      invalidateAll();
    }
  }
</script>

<svelte:head>
  <title>Organizations</title>
</svelte:head>

<div class="container max-w-6xl px-6 py-8 compact:py-4 mx-auto">
  <div class="flex items-center justify-between mb-6 compact:mb-3">
    <h1 class="text-2xl font-semibold tracking-tight">Organizations</h1>
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger>
          <span>
            <Button href={data.canCreateOrganization ? "/organizations/create" : undefined} disabled={!data.canCreateOrganization}>
              <Plus class="w-4 h-4" />
              Create Organization
            </Button>
          </span>
        </Tooltip.Trigger>
        {#if !data.canCreateOrganization}
          <Tooltip.Content>
            {#if data.organizations && data.organizations.length > 0 && !data.license.features.multiOrg}
              Multiple organizations require an Enterprise license.
            {:else}
              Only instance admins can create organizations.
            {/if}
          </Tooltip.Content>
        {/if}
      </Tooltip.Root>
    </Tooltip.Provider>
  </div>

  {#if data.organizations && data.organizations.length > 0}
    <div class="grid gap-6 compact:gap-3 md:grid-cols-2 lg:grid-cols-3">
      {#each data.organizations as org}
        <Card.Root class="overflow-hidden">
          <Card.Header class="pb-3">
            <div class="flex items-center justify-between">
              <Avatar.Root class="w-12 h-12 text-lg">
                {#if org.logo}
                  <Avatar.Image src={org.logo} alt={org.name} />
                {/if}
                <Avatar.Fallback class="bg-primary text-primary-foreground">
                  {org.name.charAt(0).toUpperCase()}
                </Avatar.Fallback>
              </Avatar.Root>

              {#if data.activeOrganizationId === org.id}
                <Badge variant="default">Active</Badge>
              {/if}
            </div>
          </Card.Header>

          <Card.Content class="pb-3">
            <Card.Title class="mb-1">{org.name}</Card.Title>
            <Card.Description>/{org.slug}</Card.Description>
          </Card.Content>

          <Card.Footer class="flex gap-2">
            {#if data.activeOrganizationId === org.id}
              <Button variant="outline" href="/organizations/{org.slug}" class="flex-1">
                Manage
              </Button>
            {:else}
              <Button variant="outline" href="/organizations/{org.slug}" class="flex-1">
                View
              </Button>
              <Button onclick={() => switchOrganization(org.id)} class="flex-1">
                Activate
              </Button>
            {/if}
          </Card.Footer>
        </Card.Root>
      {/each}
    </div>
  {:else}
    <Card.Root class="py-12">
      <Card.Content class="flex flex-col items-center text-center">
        <div class="flex items-center justify-center w-12 h-12 mb-4 rounded-full bg-muted">
          <Building2 class="w-6 h-6 text-muted-foreground" />
        </div>
        <Card.Title class="mb-2">No organizations</Card.Title>
        <Card.Description class="mb-6">
          {#if data.canCreateOrganization}
            Get started by creating your first organization.
          {:else}
            Contact an instance admin to create an organization for you.
          {/if}
        </Card.Description>
        <Tooltip.Provider>
          <Tooltip.Root>
            <Tooltip.Trigger>
              <span>
                <Button href={data.canCreateOrganization ? "/organizations/create" : undefined} disabled={!data.canCreateOrganization}>
                  <Plus class="w-4 h-4" />
                  Create Organization
                </Button>
              </span>
            </Tooltip.Trigger>
            {#if !data.canCreateOrganization}
              <Tooltip.Content>
                {#if !data.license.features.multiOrg}
                  Multiple organizations require an Enterprise license.
                {:else}
                  Only instance admins can create organizations.
                {/if}
              </Tooltip.Content>
            {/if}
          </Tooltip.Root>
        </Tooltip.Provider>
      </Card.Content>
    </Card.Root>
  {/if}

  <InviteSection invites={data.invites} />
</div>
