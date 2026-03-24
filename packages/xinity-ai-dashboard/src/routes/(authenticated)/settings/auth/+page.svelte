<script lang="ts">
  import PasswordChange from "../PasswordChange.svelte";
  import PasskeyManagement from "../PasskeyManagement.svelte";
  import DashboardApiKeyManagement from "../DashboardApiKeyManagement.svelte";
  import { Separator } from "$lib/components/ui/separator";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { ChevronRight, Lock, Fingerprint, KeyRound } from "@lucide/svelte";

  type Section = "password" | "passkeys" | "apiKeys";
  let openSection = $state<Section | null>("password");

  function toggle(section: Section) {
    openSection = openSection === section ? null : section;
  }
</script>

<div class="space-y-6">
  <div>
    <h2 class="text-lg font-semibold tracking-tight">Authentication Settings</h2>
    <p class="text-sm text-muted-foreground">Manage your password, passkeys, and API keys</p>
  </div>

  <Separator />

  <Collapsible.Root open={openSection === "password"} onOpenChange={() => toggle("password")}>
    <Collapsible.Trigger class="flex w-full items-center gap-3 py-2 cursor-pointer">
      <ChevronRight class="w-4 h-4 text-muted-foreground transition-transform duration-200 {openSection === 'password' ? 'rotate-90' : ''}" />
      <Lock class="w-4 h-4 text-muted-foreground" />
      <div class="text-left">
        <h3 class="text-base font-semibold">Password</h3>
        <p class="text-sm text-muted-foreground">Change your account password</p>
      </div>
    </Collapsible.Trigger>
    <Collapsible.Content>
      <div class="pt-4 pl-7">
        <PasswordChange />
      </div>
    </Collapsible.Content>
  </Collapsible.Root>

  <Separator />

  <Collapsible.Root open={openSection === "passkeys"} onOpenChange={() => toggle("passkeys")}>
    <Collapsible.Trigger class="flex w-full items-center gap-3 py-2 cursor-pointer">
      <ChevronRight class="w-4 h-4 text-muted-foreground transition-transform duration-200 {openSection === 'passkeys' ? 'rotate-90' : ''}" />
      <Fingerprint class="w-4 h-4 text-muted-foreground" />
      <div class="text-left">
        <h3 class="text-base font-semibold">Passkeys</h3>
        <p class="text-sm text-muted-foreground">Sign in without passwords using passkeys</p>
      </div>
    </Collapsible.Trigger>
    <Collapsible.Content>
      <div class="pt-4 pl-7">
        <PasskeyManagement />
      </div>
    </Collapsible.Content>
  </Collapsible.Root>

  <Separator />

  <Collapsible.Root open={openSection === "apiKeys"} onOpenChange={() => toggle("apiKeys")}>
    <Collapsible.Trigger class="flex w-full items-center gap-3 py-2 cursor-pointer">
      <ChevronRight class="w-4 h-4 text-muted-foreground transition-transform duration-200 {openSection === 'apiKeys' ? 'rotate-90' : ''}" />
      <KeyRound class="w-4 h-4 text-muted-foreground" />
      <div class="text-left">
        <h3 class="text-base font-semibold">Dashboard API Keys</h3>
        <p class="text-sm text-muted-foreground">Authenticate requests to the dashboard API</p>
      </div>
    </Collapsible.Trigger>
    <Collapsible.Content>
      <div class="pt-4 pl-7">
        <DashboardApiKeyManagement />
      </div>
    </Collapsible.Content>
  </Collapsible.Root>
</div>
