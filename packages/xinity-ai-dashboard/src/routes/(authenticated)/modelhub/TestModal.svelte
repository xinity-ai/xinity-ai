<script lang="ts">
  import type { Snippet } from "svelte";
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Alert from "$lib/components/ui/alert";
  import { X } from "@lucide/svelte";

  import type { DeploymentDefinition } from "./+page.server";
  import TestApiKeySection from "./TestApiKeySection.svelte";

  let {
    open = $bindable(false),
    deployment,
    title,
    apiKey = $bindable(""),
    apiKeyHint,
    onClose,
    onOpen,
    body,
    footer,
    extraHeader,
  }: {
    open: boolean;
    deployment: DeploymentDefinition | null;
    title: string;
    apiKey: string;
    apiKeyHint: string;
    onClose: () => void;
    onOpen?: () => void;
    body: Snippet;
    footer: Snippet;
    extraHeader?: Snippet;
  } = $props();

  let wasOpen = $state(false);
  $effect(() => {
    if (open && !wasOpen) {
      onOpen?.();
    }
    wasOpen = open;
  });
</script>

<Modal {open} onClose={onClose} class="z-40">
  {#if open && deployment}
    <div class="bg-card rounded-xl shadow-2xl w-full max-w-3xl min-w-[min(48rem,90vw)] max-h-[90vh] flex flex-col">
      <header class="p-6 border-b flex justify-between items-center">
        <div>
          <h2 class="text-2xl font-semibold">{title}</h2>
          <p class="text-sm text-muted-foreground mt-1">
            <span class="font-mono">{deployment.publicSpecifier}</span>
          </p>
          {#if extraHeader}
            {@render extraHeader()}
          {/if}
        </div>
        <Button variant="ghost" size="icon" onclick={onClose} aria-label="Close test modal">
          <X class="w-5 h-5" />
        </Button>
      </header>

      <main class="p-6 flex-1 overflow-y-auto space-y-5">
        <TestApiKeySection bind:apiKey deploymentName={deployment.name} />
        {@render body()}
        {#if !apiKey.trim()}
          <Alert.Root>
            <Alert.Description class="text-xs">{apiKeyHint}</Alert.Description>
          </Alert.Root>
        {/if}
      </main>

      <footer class="p-4 border-t bg-muted/40 rounded-b-xl">
        {@render footer()}
      </footer>
    </div>
  {/if}
</Modal>
