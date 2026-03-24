<script lang="ts">
  import { orpc } from "$lib/orpc/orpc-client";
  import { invalidateAll } from "$app/navigation";
  import { toastState } from "$lib/state/toast.svelte";
  import type { DisplaySettings } from "common-db";

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

  type ChecklistData = {
    hasOrganization: boolean;
    hasDeployment: boolean;
    hasApiCall: boolean;
    hasLabeledCall: boolean;
    hasInvitation: boolean;
    hasApplication: boolean;
  };

  let {
    checklist,
    displaySettings,
  }: {
    checklist: ChecklistData;
    displaySettings: DisplaySettings;
  } = $props();

  let isDismissing = $state(false);

  const hasOrg = $derived(checklist.hasOrganization);

  const steps = $derived([
    {
      label: "Create your organization",
      complete: checklist.hasOrganization,
      href: "/organizations/create/",
      icon: Rocket,
      disabled: false,
    },
    {
      label: "Deploy your first model",
      complete: checklist.hasDeployment,
      href: "/modelhub/",
      icon: Server,
      disabled: !hasOrg,
    },
    {
      label: "Make your first API call",
      complete: checklist.hasApiCall,
      href: "/docs/quick-start/",
      icon: Send,
      disabled: !hasOrg,
    },
    {
      label: "Label an API call",
      complete: checklist.hasLabeledCall,
      href: "/data/",
      icon: ThumbsUp,
      disabled: !hasOrg,
    },
    {
      label: "Invite a team member",
      complete: checklist.hasInvitation,
      href: "/organizations/",
      icon: Users,
      disabled: !hasOrg,
    },
    {
      label: "Create an application",
      complete: checklist.hasApplication,
      href: "/ai-api-keys/",
      icon: AppWindow,
      disabled: !hasOrg,
    },
  ]);

  const completedCount = $derived(steps.filter((s) => s.complete).length);
  const totalSteps = $derived(steps.length);
  const progressPercent = $derived(Math.round((completedCount / totalSteps) * 100));
  const allComplete = $derived(completedCount === totalSteps);

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
        {#if allComplete}
          <PartyPopper class="w-5 h-5 text-green-600 shrink-0" />
          <h3 class="text-base font-semibold">All done!</h3>
        {:else}
          <Rocket class="w-5 h-5 text-blue-600 shrink-0" />
          <h3 class="text-base font-semibold">Getting Started</h3>
        {/if}
        <span class="text-xs text-muted-foreground">{completedCount}/{totalSteps}</span>
        <div class="w-20 bg-secondary rounded-full h-1.5">
          <div
            class="bg-green-500 h-1.5 rounded-full transition-all duration-500 ease-out"
            style="width: {progressPercent}%"
          ></div>
        </div>
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
    </div>
  </Card.Root>
</div>
