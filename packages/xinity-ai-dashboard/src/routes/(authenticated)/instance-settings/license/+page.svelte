<script lang="ts">
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Copy } from "@lucide/svelte";
  import { copyToClipboard } from "$lib/copy";
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();

  const tierLabel: Record<string, string> = {
    free: "Free",
    startup: "Startup",
    "enterprise-sm": "Enterprise (Small)",
    "enterprise-lg": "Enterprise (Large)",
  };
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
          {data.license.maxVramGb === Infinity ? "Unlimited" : `${data.license.maxVramGb} GB`}
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
