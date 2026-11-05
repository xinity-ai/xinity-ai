<script lang="ts">
  import type { Snippet } from "svelte";
  import SettingsNav from "$lib/components/SettingsNav.svelte";
  import { Users, Building2, Shield, KeyRound, Cpu, Wrench, SlidersHorizontal } from "@lucide/svelte";

  const { children }: { children: Snippet } = $props();

  const navItems = [
    { href: "/instance-settings/users/", label: "Users", icon: Users },
    { href: "/instance-settings/organizations/", label: "Organizations", icon: Building2 },
    { href: "/instance-settings/sso/", label: "SSO", icon: Shield },
    { href: "/instance-settings/license/", label: "License", icon: KeyRound },
    { href: "/instance-settings/compute/", label: "Compute", icon: Cpu },
    { href: "/instance-settings/configuration/", label: "Configuration", icon: SlidersHorizontal },
    { href: "/instance-settings/maintenance/", label: "Maintenance", icon: Wrench },
  ];
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
    <SettingsNav items={navItems} />

    <!-- Page content -->
    <div class="flex-1 min-w-0">
      {@render children()}
    </div>
  </div>
</div>
