<script lang="ts">
  import { page } from "$app/stores";
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

  let { isInstanceAdmin = false, license }: { isInstanceAdmin?: boolean; license?: LicenseSummary } = $props();

  let isLoggingOut = $state(false);

  const linkClasses =
    "relative flex flex-row items-center pr-6 text-gray-600 border-l-4 border-transparent h-11 compact:h-9 focus:outline-none hover:bg-gray-50 hover:text-gray-800 hover:border-indigo-500";
  const activeLinkClasses = "!bg-gray-50 !text-gray-800 !border-indigo-500";

  const links = {
    home: "/",
    apikeys: "/ai-api-keys/",

    data: "/data/",
    training: "/training/",
    modelhub: "/modelhub/",
    organizations: "/organizations/",
    instanceSettings: "/instance-settings/",
    settings: "/settings/",
    docs: "/docs/",
  };

  const pathname = $derived($page.url.pathname);
  const activeLink = $derived(
    pathname === "/"
      ? "home"
      : Object.entries(links)
          .filter(([key, path]) => key !== "home") // Skip home for non-root paths
          .find(([key, path]) => pathname.startsWith(path))?.[0] || "home",
  );
</script>

<nav
  class="fixed top-0 left-0 z-40 flex flex-col h-full bg-white border-r sm:w-64 w-14"
>
  <div
    class="flex flex-col justify-between grow overflow-x-hidden overflow-y-auto"
  >
      <ul class="flex flex-col pl-0 py-4! compact:py-2! space-y-1 compact:space-y-0">
        <li class="sr-only">Menu</li>
        <li>
          <a
            href={links.home}
            aria-label="Home"
            class="{linkClasses} {activeLink === 'home'
              ? activeLinkClasses
              : ''}"
          >
            <span
              title="Home"
              class="inline-flex items-center justify-center ml-4"
            >
              <HomeIcon class="w-5 h-5" />
            </span>
            <span class="ml-2 text-sm tracking-wide truncate">Home</span>
          </a>
        </li>
        <li class="hidden px-5! sm:block">
          <div class="flex items-center h-8 compact:h-6">
            <div class="text-sm font-light tracking-wide text-gray-500">
              Functions
            </div>
          </div>
        </li>
        {#if permissions.canViewApiKeys || permissions.canManageApiKeys}
          <li>
            <a
              href={links.apikeys}
              aria-label="AI API Keys"
              class="{linkClasses} {activeLink === 'apikeys'
                ? activeLinkClasses
                : ''}"
            >
              <span
                title="AI API Keys"
                class="inline-flex items-center justify-center ml-4"
              >
                <CodeIcon class="w-5 h-5" />
              </span>
              <span class="ml-2 text-sm tracking-wide truncate">AI API Keys</span>
            </a>
          </li>
        {/if}
        {#if permissions.canViewData}
          <li>
            <a
              href={links.data}
              aria-label="Data"
              class="{linkClasses} {activeLink === 'data'
                ? activeLinkClasses
                : ''}"
            >
              <span
                title="Data"
                class="inline-flex items-center justify-center ml-4"
              >
                <DataIcon class="w-5 h-5" />
              </span>
              <span class="ml-2 text-sm tracking-wide truncate">Data</span>
            </a>
          </li>
        {/if}
        {#if permissions.canViewModels}
          <li>
            <a
              href={links.training}
              aria-label="Training"
              class="{linkClasses} {activeLink === 'training'
                ? activeLinkClasses
                : ''}"
            >
              <span
                title="Training"
                class="inline-flex items-center justify-center ml-4"
              >
                <ThunderIcon class="w-5 h-5" />
              </span>
              <span class="ml-2 text-sm tracking-wide truncate">Training</span>
            </a>
          </li>
        {/if}
        {#if permissions.canViewDeployments}
          <li>
            <a
              href={links.modelhub}
              aria-label="Model Hub"
              class="{linkClasses} {activeLink === 'modelhub'
                ? activeLinkClasses
                : ''}"
            >
              <span
                title="Model Hub"
                class="inline-flex items-center justify-center ml-4"
              >
                <ModelIcon class="w-5 h-5" />
              </span>
              <span class="ml-2 text-sm tracking-wide truncate">Model Hub</span>
            </a>
          </li>
        {/if}
        <li class="hidden px-5! sm:block">
          <div class="flex items-center h-8 compact:h-6">
            <div class="text-sm font-light tracking-wide text-gray-500">
              User
            </div>
          </div>
        </li>
        <li>
          <a
            href={links.organizations}
            aria-label="Organizations"
            class="{linkClasses} {activeLink === 'organizations'
              ? activeLinkClasses
              : ''}"
          >
            <span
              title="Organizations"
              class="inline-flex items-center justify-center ml-4"
            >
              <OrganizationIcon class="w-5 h-5" />
            </span>
            <span class="ml-2 text-sm tracking-wide truncate"
              >Organizations</span
            >
          </a>
        </li>
        {#if isInstanceAdmin}
          <li>
            <a
              href={links.instanceSettings}
              aria-label="Instance Settings"
              class="{linkClasses} {activeLink === 'instanceSettings'
                ? activeLinkClasses
                : ''}"
            >
              <span
                title="Instance Settings"
                class="inline-flex items-center justify-center ml-4"
              >
                <Shield class="w-5 h-5" />
              </span>
              <span class="ml-2 text-sm tracking-wide truncate">Instance Settings</span>
            </a>
          </li>
        {/if}
        <li>
          <a
            href={links.settings}
            aria-label="Settings"
            class="{linkClasses} {activeLink === 'settings'
              ? activeLinkClasses
              : ''}"
          >
            <span
              title="Settings"
              class="inline-flex items-center justify-center ml-4"
            >
              <GearIcon class="w-5 h-5" />
            </span>
            <span class="ml-2 text-sm tracking-wide truncate">Settings</span>
          </a>
        </li>
        <li class="hidden px-5! sm:block">
          <div class="my-1 border-t border-gray-200"></div>
        </li>
        <li>
          <a
            href={links.docs}
            aria-label="Documentation"
            class="{linkClasses} {activeLink === 'docs'
              ? activeLinkClasses
              : 'text-indigo-500!'}"
          >
            <span
              title="Documentation"
              class="inline-flex items-center justify-center ml-4"
            >
              <BookOpen class="w-5 h-5" />
            </span>
            <span class="ml-2 text-sm tracking-wide truncate">Docs</span>
          </a>
        </li>
        <li>
          <button
            onclick={() => {
              isLoggingOut = true;
              signOut().then(() => goto("/login")).catch(() => { isLoggingOut = false; });
            }}
            disabled={isLoggingOut}
            aria-label="Logout"
            class="{linkClasses} cursor-pointer w-full disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span
              title="Logout"
              class="inline-flex items-center justify-center ml-4"
            >
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
        <a
          href="https://xinity.ai"
          target="_blank"
          rel="noopener noreferrer"
          class="text-xs text-gray-400 hover:text-indigo-500"
        >
          Powered by Xinity AI
        </a>
      {/if}
    </div>
</nav>
