<script lang="ts">
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Copy, CheckCircle2, Lock } from "@lucide/svelte";
  import { copyToClipboard } from "$lib/copy";
  import type { PageData } from "./$types";
  import { formatGb } from "$lib/util";

  const { data }: { data: PageData } = $props();

  const tierLabel: Record<string, string> = {
    free: "Free",
    startup: "Startup",
    "enterprise-sm": "Enterprise (Small)",
    "enterprise-lg": "Enterprise (Large)",
  };

  type FeatureKey = keyof PageData["license"]["features"];

  const featureCatalog: { key: FeatureKey; label: string; description: string }[] = [
    {
      key: "sso",
      label: "Single sign-on",
      description: "Authenticate users through an external OIDC or SAML identity provider.",
    },
    {
      key: "ssoSelfManage",
      label: "Self-managed SSO",
      description: "Let organization admins register their own SSO provider without an instance admin.",
    },
    {
      key: "multiOrg",
      label: "Multiple organizations",
      description: "Run more than one organization on this instance.",
    },
    {
      key: "allRoles",
      label: "Full role set",
      description: "Assign the member, labeler and viewer roles on top of owner and admin.",
    },
    {
      key: "auditLog",
      label: "Audit log",
      description: "Browse and export the record of security-relevant actions.",
    },
  ];
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>License</Card.Title>
    <Card.Description>Active license details for this dashboard install.</Card.Description>
  </Card.Header>
  <Card.Content class="space-y-6">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <p class="text-sm text-muted-foreground">Tier</p>
        <p class="font-medium">{tierLabel[data.license.tier] ?? data.license.tier}</p>
      </div>
      <div>
        <p class="text-sm text-muted-foreground">Licensee</p>
        <p class="font-medium">{data.license.licensee ?? "-"}</p>
      </div>
      <div>
        <p class="text-sm text-muted-foreground">Max VRAM</p>
        <p class="font-medium">
          {data.license.maxVramGb === Infinity ? "Unlimited" : formatGb(data.license.maxVramGb)}
        </p>
      </div>
      <div>
        <p class="text-sm text-muted-foreground">Status</p>
        <div class="flex flex-wrap gap-2 mt-0.5">
          {#if data.license.expired && !data.license.inGracePeriod}
            <Badge variant="destructive">Expired</Badge>
          {:else if data.license.inGracePeriod}
            <Badge variant="outline">Grace period</Badge>
          {:else if data.license.tier !== "free"}
            <Badge>Active</Badge>
          {:else}
            <Badge variant="outline">Free tier</Badge>
          {/if}
          {#if data.license.originMismatch}
            <Badge variant="destructive">Origin mismatch</Badge>
          {/if}
          {#if data.license.instanceMismatch}
            <Badge variant="destructive">Instance mismatch</Badge>
          {/if}
        </div>
      </div>
    </div>

    <div class="border-t pt-6">
      <p class="text-sm text-muted-foreground">Features</p>
      <p class="text-xs text-muted-foreground mt-1 mb-3">
        Unlocked by the active license. An expired, origin-mismatched or instance-mismatched license falls back to
        the free tier, which unlocks none of these.
      </p>
      <ul class="divide-y rounded border">
        {#each featureCatalog as feature (feature.key)}
          {@const enabled = data.license.features[feature.key]}
          <li class="flex items-start gap-3 px-3 py-2.5">
            {#if enabled}
              <CheckCircle2 class="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
            {:else}
              <Lock class="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
            {/if}
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium" class:text-muted-foreground={!enabled}>{feature.label}</p>
              <p class="text-xs text-muted-foreground">{feature.description}</p>
            </div>
            <Badge variant={enabled ? "default" : "outline"} class="shrink-0">
              {enabled ? "Included" : "Not included"}
            </Badge>
          </li>
        {/each}
      </ul>
    </div>

    <div class="border-t pt-6">
      <p class="text-sm text-muted-foreground">Deployment instance ID</p>
      <p class="text-xs text-muted-foreground mt-1 mb-2">
        Provide this ID when requesting a license to bind it to this specific dashboard install.
      </p>
      {#if data.instanceId}
        <div class="flex items-center gap-2">
          <code class="flex-1 px-3 py-2 rounded bg-muted text-sm font-mono break-all">{data.instanceId}</code>
          <Button
            variant="outline"
            size="icon"
            title="Copy instance ID"
            aria-label="Copy instance ID"
            onclick={() => copyToClipboard(data.instanceId!)}
          >
            <Copy class="w-4 h-4" />
          </Button>
        </div>
      {:else}
        <p class="text-sm text-muted-foreground italic">Not yet initialised. Restart the dashboard to generate one.</p>
      {/if}
    </div>
  </Card.Content>
</Card.Root>
