<script lang="ts">
  import { page } from "$app/state";
  import type { Component } from "svelte";
  import LogoutIcon from "$lib/components/icons/LogoutIcon.svelte";
  import { signOut } from "$lib/auth";
  import HomeIcon from "$lib/components/icons/HomeIcon.svelte";
  import CodeIcon from "$lib/components/icons/CodeIcon.svelte";
  import DataIcon from "$lib/components/icons/DataIcon.svelte";
  import ThunderIcon from "$lib/components/icons/ThunderIcon.svelte";
  import ModelIcon from "$lib/components/icons/ModelIcon.svelte";
  import OrganizationIcon from "$lib/components/icons/OrganizationIcon.svelte";
  import GearIcon from "$lib/components/icons/GearIcon.svelte";
  import { Shield, BookOpen } from "@lucide/svelte";
  import { goto } from "$app/navigation";
  import { permissions } from "$lib/state/permissions.svelte";

  import type { LicenseSummary } from "$lib/server/license";

  let { isInstanceAdmin = false, license, version }: { isInstanceAdmin?: boolean; license?: LicenseSummary; version?: string } = $props();

  let isLoggingOut = $state(false);

  type NavItem = {
    key: string;
    href: string;
    label: string;
    icon: Component<{ class?: string }>;
    show?: boolean;
    exact?: boolean;
    accentWhenInactive?: boolean;
  };

  type NavSection = {
    heading?: string;
    divider?: boolean;
    items: NavItem[];
  };

  const sections = $derived<NavSection[]>([
    {
      items: [
        { key: "home", href: "/", label: "Home", icon: HomeIcon, exact: true },
      ],
    },
    {
      heading: "Functions",
      items: [
        { key: "apikeys",  href: "/ai-api-keys/", label: "AI API Keys", icon: CodeIcon,    show: permissions.canViewApiKeys || permissions.canManageApiKeys },
        { key: "data",     href: "/data/",         label: "Data",        icon: DataIcon,    show: permissions.canViewData },
        { key: "training", href: "/training/",     label: "Training",    icon: ThunderIcon, show: permissions.canViewModels },
        { key: "modelhub", href: "/modelhub/",     label: "Model Hub",   icon: ModelIcon,   show: permissions.canViewDeployments },
      ],
    },
    {
      heading: "User",
      items: [
        { key: "organizations",    href: "/organizations/",    label: "Organizations",    icon: OrganizationIcon },
        { key: "instanceSettings", href: "/instance-settings/", label: "Instance Settings", icon: Shield, show: isInstanceAdmin },
        { key: "settings",         href: "/settings/",          label: "Settings",           icon: GearIcon },
      ],
    },
    {
      divider: true,
      items: [
        { key: "docs", href: "/docs/", label: "Docs", icon: BookOpen, accentWhenInactive: true },
      ],
    },
  ]);

  const linkClasses =
    "relative flex flex-row items-center pr-6 text-gray-600 border-l-4 border-transparent h-11 compact:h-9 focus:outline-none hover:bg-xinity-purple/5 hover:text-gray-800 hover:border-xinity-purple";
  const activeLinkClasses = "!bg-xinity-purple/5 !text-gray-800 !border-xinity-purple";

  const pathname = $derived(page.url.pathname);
</script>

<nav
  class="fixed top-0 left-0 z-40 flex flex-col h-full bg-white border-r sm:w-64 w-14"
>
  <div class="flex items-center justify-center px-3 py-4 compact:py-2 border-b border-gray-200">
    <a href="/" class="flex items-center">
      <img src="/xinity-logo.png" alt="Xinity" class="h-8 sm:h-9 w-auto" />
    </a>
  </div>
  <div class="flex flex-col justify-between grow overflow-x-hidden overflow-y-auto">
    <ul class="flex flex-col pl-0 py-4! compact:py-2! space-y-1 compact:space-y-0">
      <li class="sr-only">Menu</li>
      {#each sections as section}
        {#if section.divider}
          <li class="hidden px-5! sm:block">
            <div class="my-1 border-t border-gray-200"></div>
          </li>
        {/if}
        {#if section.heading && section.items.some((item) => item.show !== false)}
          <li class="hidden px-5! sm:block">
            <div class="flex items-center h-8 compact:h-6">
              <div class="text-sm font-light tracking-wide text-gray-500">{section.heading}</div>
            </div>
          </li>
        {/if}
        {#each section.items.filter((item) => item.show !== false) as item}
          {@const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href)}
          <li>
            <a
              href={item.href}
              aria-label={item.label}
              class="{linkClasses} {isActive ? activeLinkClasses : item.accentWhenInactive ? 'text-xinity-magenta!' : ''}"
            >
              <span title={item.label} class="inline-flex items-center justify-center ml-4">
                <item.icon class="w-5 h-5" />
              </span>
              <span class="ml-2 text-sm tracking-wide truncate">{item.label}</span>
            </a>
          </li>
        {/each}
      {/each}
      <li>
        <button
          onclick={() => {
            isLoggingOut = true;
            signOut().then(() => goto("/login", { invalidateAll: true })).finally(() => { isLoggingOut = false; });
          }}
          disabled={isLoggingOut}
          aria-label="Logout"
          class="{linkClasses} cursor-pointer w-full disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span title="Logout" class="inline-flex items-center justify-center ml-4">
            <LogoutIcon class="w-5 h-5" />
          </span>
          <span class="ml-2 text-sm tracking-wide truncate">
            {isLoggingOut ? "Logging out..." : "Logout"}
          </span>
        </button>
      </li>
    </ul>
  </div>
  <div class="border-t border-gray-200 px-4 py-2 text-center">
    {#if license?.licensee}
      <span class="text-xs text-gray-400">{license.licensee}</span>
    {:else}
      <div class="flex flex-col items-center gap-1">
        <a
          href="https://xinity.ai/xinity-pricing"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 hover:bg-amber-100 transition-colors"
        >
          <span class="hidden sm:inline">Free Tier</span>
        </a>
        <a
          href="https://xinity.ai"
          target="_blank"
          rel="noopener noreferrer"
          class="text-xs text-gray-400 hover:text-xinity-magenta hidden sm:inline"
        >
          Powered by Xinity AI
        </a>
      </div>
    {/if}
    {#if version}
      <p class="text-[10px] text-gray-400 mt-1 hidden sm:block">v{version}</p>
    {/if}
  </div>
</nav>
