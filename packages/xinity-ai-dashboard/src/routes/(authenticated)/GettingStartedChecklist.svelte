<script lang="ts">
  import { orpc } from "$lib/orpc/orpc-client";
  import { invalidateAll } from "$app/navigation";
  import { toastState } from "$lib/state/toast.svelte";
  import type { DisplaySettings } from "common-db";
  import type { ChecklistData } from "./dashboard.types";

  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";

  import {
    CheckCircle2,
    Circle,
    X,
    PartyPopper,
    Rocket,
    Server,
    Send,
    ThumbsUp,
    Users,
    AppWindow,
    Loader2,
  } from "@lucide/svelte";

  let {
    checklist,
    displaySettings,
  }: {
    checklist: Promise<ChecklistData>;
    displaySettings: DisplaySettings;
  } = $props();

  let isDismissing = $state(false);
  let resolved = $state<ChecklistData | null>(null);

  $effect(() => {
    checklist.then(data => { resolved = data; });
  });

  const hasOrg = $derived(resolved?.hasOrganization ?? false);

  const steps = $derived(resolved ? [
    {
      label: "Create your organization",
      complete: resolved.hasOrganization,
      href: "/organizations/create/",
      icon: Rocket,
      disabled: false,
    },
    {
      label: "Deploy your first model",
      complete: resolved.hasDeployment,
      href: "/modelhub/",
      icon: Server,
      disabled: !hasOrg,
    },
    {
      label: "Make your first API call",
      complete: resolved.hasApiCall,
      href: "/docs/quick-start/",
      icon: Send,
      disabled: !hasOrg,
    },
    {
      label: "Label an API call",
      complete: resolved.hasLabeledCall,
      href: "/data/",
      icon: ThumbsUp,
      disabled: !hasOrg,
    },
    {
      label: "Invite a team member",
      complete: resolved.hasInvitation,
      href: "/organizations/",
      icon: Users,
      disabled: !hasOrg,
    },
    {
      label: "Create an application",
      complete: resolved.hasApplication,
      href: "/ai-api-keys/",
      icon: AppWindow,
      disabled: !hasOrg,
    },
  ] : null);

  const completedCount = $derived(steps ? steps.filter((s) => s.complete).length : 0);
  const totalSteps = $derived(steps ? steps.length : 6);
  const progressPercent = $derived(Math.round((completedCount / totalSteps) * 100));
  const allComplete = $derived(steps != null && completedCount === totalSteps);

  async function dismiss() {
    isDismissing = true;
    const [error] = await orpc.user.updateSettings({
      displaySettings: {
        ...displaySettings,
        gettingStartedDismissed: true,
      },
    });
    if (error) {
      toastState.add(error.message, "error");
      isDismissing = false;
    } else {
      await invalidateAll();
    }
  }
</script>

<div class="p-6 compact:p-3 pb-0 compact:pb-0">
  <Card.Root class="p-4 compact:p-3">
    <div class="flex items-center justify-between mb-3 compact:mb-2">
      <div class="flex items-center gap-2">
        {#if steps == null}
          <Rocket class="w-5 h-5 text-xinity-magenta shrink-0" />
          <h3 class="text-base font-semibold">Getting Started</h3>
          <div class="w-10 h-4 bg-gray-200 rounded animate-pulse"></div>
          <div class="w-20 bg-secondary rounded-full h-1.5">
            <div class="bg-gray-300 h-1.5 rounded-full w-0"></div>
          </div>
        {:else if allComplete}
          <PartyPopper class="w-5 h-5 text-green-600 shrink-0" />
          <h3 class="text-base font-semibold">All done!</h3>
          <span class="text-xs text-muted-foreground">{completedCount}/{totalSteps}</span>
          <div class="w-20 bg-secondary rounded-full h-1.5">
            <div
              class="bg-green-500 h-1.5 rounded-full transition-all duration-500 ease-out"
              style="width: {progressPercent}%"
            ></div>
          </div>
        {:else}
          <Rocket class="w-5 h-5 text-xinity-magenta shrink-0" />
          <h3 class="text-base font-semibold">Getting Started</h3>
          <span class="text-xs text-muted-foreground">{completedCount}/{totalSteps}</span>
          <div class="w-20 bg-secondary rounded-full h-1.5">
            <div
              class="bg-green-500 h-1.5 rounded-full transition-all duration-500 ease-out"
              style="width: {progressPercent}%"
            ></div>
          </div>
        {/if}
      </div>
      <Button
        variant="ghost"
        size="icon"
        class="h-7 w-7"
        onclick={dismiss}
        disabled={isDismissing}
        title="Dismiss checklist"
      >
        {#if isDismissing}
          <Loader2 class="w-3.5 h-3.5 animate-spin" />
        {:else}
          <X class="w-3.5 h-3.5" />
        {/if}
      </Button>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 compact:gap-1">
      {#if steps == null}
        {#each Array(6) as _}
          <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-dashed animate-pulse">
            <div class="w-4 h-4 bg-gray-200 rounded-full shrink-0"></div>
            <div class="h-3 bg-gray-200 rounded w-28"></div>
            <div class="w-3.5 h-3.5 bg-gray-100 rounded shrink-0 ml-auto"></div>
          </div>
        {/each}
      {:else}
        {#each steps as step}
          {#if step.complete}
            <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-green-50 border border-green-200">
              <CheckCircle2 class="w-4 h-4 text-green-600 shrink-0" />
              <span class="text-xs font-medium text-green-800 line-through truncate">{step.label}</span>
            </div>
          {:else if step.disabled}
            <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-dashed opacity-40 cursor-default">
              <Circle class="w-4 h-4 shrink-0" />
              <span class="text-xs font-medium truncate">{step.label}</span>
              <step.icon class="w-3.5 h-3.5 shrink-0 ml-auto" />
            </div>
          {:else}
            <a
              href={step.href}
              class="flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-card hover:bg-accent transition-colors"
            >
              <Circle class="w-4 h-4 text-muted-foreground shrink-0" />
              <span class="text-xs font-medium truncate">{step.label}</span>
              <step.icon class="w-3.5 h-3.5 text-muted-foreground shrink-0 ml-auto" />
            </a>
          {/if}
        {/each}
      {/if}
    </div>
  </Card.Root>
</div>
