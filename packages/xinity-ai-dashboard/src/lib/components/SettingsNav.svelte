<script lang="ts">
  import { page } from "$app/state";
  import type { Component } from "svelte";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";

  type NavItem = { href: string; label: string; icon: Component<{ class?: string }> };

  let { items }: { items: NavItem[] } = $props();
</script>

<div class="w-full md:w-56 shrink-0">
  <Card.Root class="sticky top-8">
    <Card.Content class="p-2">
      <nav class="flex flex-col gap-1">
        {#each items as item (item.href)}
          <Button
            variant={page.url.pathname.startsWith(item.href) ? "secondary" : "ghost"}
            href={item.href}
            class="justify-start w-full"
          >
            <item.icon class="w-4 h-4" />
            {item.label}
          </Button>
        {/each}
      </nav>
    </Card.Content>
  </Card.Root>
</div>
