<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import * as Avatar from "$lib/components/ui/avatar";
  import { ArrowLeft, Pencil } from "@lucide/svelte";

  let {
    name,
    slug,
    logo,
    canEdit,
    onEditClick,
  }: {
    name: string;
    slug: string;
    logo?: string | null;
    canEdit: boolean;
    onEditClick: () => void;
  } = $props();
</script>

<div class="mb-6">
  <Button variant="ghost" href="/organizations" class="mb-4 -ml-2">
    <ArrowLeft class="w-4 h-4" />
    Back to Organizations
  </Button>

  <div class="flex items-center justify-between">
    <div class="flex items-center gap-4">
      <Avatar.Root class="w-16 h-16 text-lg">
        {#if logo}
          <Avatar.Image src={logo} alt={name} />
        {/if}
        <Avatar.Fallback class="bg-primary text-primary-foreground">
          {name?.charAt(0).toUpperCase()}
        </Avatar.Fallback>
      </Avatar.Root>
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">
          {name}
        </h1>
        <p class="text-sm text-muted-foreground">/{slug}</p>
      </div>
    </div>
    {#if canEdit}
      <Button variant="outline" onclick={onEditClick}>
        <Pencil class="w-4 h-4" />
        Edit
      </Button>
    {/if}
  </div>
</div>
