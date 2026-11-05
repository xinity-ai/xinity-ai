<script lang="ts">
  import type { Snippet } from "svelte";
  import * as Card from "$lib/components/ui/card";
  import SettingsNav from "$lib/components/SettingsNav.svelte";
  import { User, Bell, Monitor, Shield } from "@lucide/svelte";

  const { children }: { children: Snippet } = $props();

  const navItems = [
    { href: "/settings/profile/", label: "Profile", icon: User },
    { href: "/settings/notifications/", label: "Notifications", icon: Bell },
    { href: "/settings/display/", label: "Display", icon: Monitor },
    { href: "/settings/auth/", label: "Authentication", icon: Shield },
  ];
</script>

<svelte:head>
  <title>Settings</title>
</svelte:head>

<div class="container max-w-5xl px-6 py-8 compact:py-4 mx-auto">
  <h1 class="mb-8 compact:mb-4 text-2xl font-semibold tracking-tight">Settings</h1>

  <div class="flex flex-col md:flex-row gap-8 compact:gap-4">
    <SettingsNav items={navItems} />

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
