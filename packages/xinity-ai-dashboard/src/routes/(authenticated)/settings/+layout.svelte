<script lang="ts">
  import { page } from "$app/stores";
  import type { Snippet } from "svelte";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { User, Bell, Monitor, Shield } from "@lucide/svelte";

  const { children }: { children: Snippet } = $props();

  const navItems = [
    { href: "/settings/profile", label: "Profile", icon: User },
    { href: "/settings/notifications", label: "Notifications", icon: Bell },
    { href: "/settings/display", label: "Display", icon: Monitor },
    { href: "/settings/auth", label: "Authentication", icon: Shield },
  ];

  const currentPath = $derived($page.url.pathname);
</script>

<svelte:head>
  <title>Settings</title>
</svelte:head>

<div class="container max-w-5xl px-6 py-8 compact:py-4 mx-auto">
  <h1 class="mb-8 compact:mb-4 text-2xl font-semibold tracking-tight">Settings</h1>

  <div class="flex flex-col md:flex-row gap-8 compact:gap-4">
    <!-- Navigation -->
    <div class="w-full md:w-56 shrink-0">
      <Card.Root class="sticky top-8">
        <Card.Content class="p-2">
          <nav class="flex flex-col gap-1">
            {#each navItems as item (item.href)}
              {@const isActive = currentPath === item.href}
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
      <Card.Root>
        <Card.Content class="p-6 compact:p-4">
          {@render children()}
        </Card.Content>
      </Card.Root>
    </div>
  </div>
</div>
