<script lang="ts">
  import { page } from "$app/stores";
  import type { Snippet } from "svelte";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Users, Building2, Shield, KeyRound } from "@lucide/svelte";

  const { children }: { children: Snippet } = $props();

  const navItems = [
    { href: "/instance-settings/users", label: "Users", icon: Users },
    { href: "/instance-settings/organizations", label: "Organizations", icon: Building2 },
    { href: "/instance-settings/sso", label: "SSO", icon: Shield },
    { href: "/instance-settings/license", label: "License", icon: KeyRound },
  ];

  const currentPath = $derived($page.url.pathname);
</script>

<svelte:head>
  <title>Instance Settings</title>
</svelte:head>

<div class="container max-w-6xl px-6 py-8 compact:py-4 mx-auto">
  <div class="mb-6 compact:mb-3">
    <h1 class="text-2xl font-bold text-foreground">Instance Settings</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      Manage users, organizations, and instance-wide configuration.
    </p>
  </div>

  <div class="flex flex-col md:flex-row gap-8 compact:gap-4">
    <!-- Navigation -->
    <div class="w-full md:w-56 shrink-0">
      <Card.Root class="sticky top-8">
        <Card.Content class="p-2">
          <nav class="flex flex-col gap-1">
            {#each navItems as item (item.href)}
              {@const isActive = currentPath.startsWith(item.href)}
              <Button
                variant={isActive ? "secondary" : "ghost"}
                href={item.href}
                class="justify-start w-full"
              >
                <item.icon class="w-4 h-4" />
                {item.label}
              </Button>
            {/each}
          </nav>
        </Card.Content>
      </Card.Root>
    </div>

    <!-- Page content -->
    <div class="flex-1 min-w-0">
      {@render children()}
    </div>
  </div>
</div>
