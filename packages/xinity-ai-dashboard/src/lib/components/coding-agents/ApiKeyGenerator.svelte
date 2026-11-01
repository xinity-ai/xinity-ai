<script lang="ts">
  import { KeyRound } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import CodeExample from "$lib/components/CodeExample.svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { toastState } from "$lib/state/toast.svelte";
  import { browserLogger } from "$lib/browserLogging";
  import { permissions } from "$lib/state/permissions.svelte";

  const { harness, command }: { harness: string; command: (key: string) => string } = $props();

  const canCreateKey = $derived(permissions.can("apiKey", "create"));

  let created = $state<{ name: string; fullKey: string } | null>(null);
  let creating = $state(false);

  async function create() {
    if (!canCreateKey || creating) {
      return;
    }
    creating = true;
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 12);
    const name = `${harness} - ${stamp}`;
    const [error, result] = await orpc.apiKey.create({ name, enabled: true });
    creating = false;
    if (error) {
      browserLogger.warn({ error }, "Failed to create coding agent key");
      toastState.add("Failed to create API key", "error");
      return;
    }
    created = { name, fullKey: result.fullKey };
  }
</script>

{#if canCreateKey && !created}
  <Button onclick={create} disabled={creating} class="mb-4">
    <KeyRound class="w-4 h-4" />
    {creating ? "Creating..." : `Create a key for ${harness}`}
  </Button>
{/if}

<CodeExample code={command(created?.fullKey ?? "sk_...")} language="bash" withCopy />

{#if created}
  <p class="text-sm text-gray-600 mt-2">
    This is the only time the key is shown. It is listed as
    <code class="bg-gray-100 px-1 rounded">{created.name}</code> on the
    <a href="/ai-api-keys/" class="text-xinity-magenta hover:text-xinity-pink">API keys</a> page,
    where you can revoke it.
  </p>
{:else if !canCreateKey}
  <p class="text-sm text-gray-600 mt-2">
    Replace <code class="bg-gray-100 px-1 rounded">sk_...</code> with a key from the
    <a href="/ai-api-keys/" class="text-xinity-magenta hover:text-xinity-pink">API keys</a> page.
  </p>
{/if}

<style>
  code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }
</style>
