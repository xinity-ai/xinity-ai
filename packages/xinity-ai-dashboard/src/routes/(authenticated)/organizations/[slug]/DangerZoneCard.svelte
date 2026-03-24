<script lang="ts">
  import { goto } from "$app/navigation";
  import { toastState } from "$lib/state/toast.svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Alert from "$lib/components/ui/alert";
  import { Trash2, Shield } from "@lucide/svelte";

  let {
    organizationId,
  }: {
    organizationId: string;
  } = $props();

  let showDeleteConfirm = $state(false);
  let deleting = $state(false);

  async function handleDelete() {
    deleting = true;

    const { error } = await orpc.organization.delete({});

    if (error) {
      toastState.add("Failed to delete organization", "error");
      deleting = false;
    } else {
      goto("/organizations");
    }
  }
</script>

<Card.Root class="border-destructive/50">
  <Card.Header>
    <Card.Title class="text-destructive">Danger Zone</Card.Title>
    <Card.Description>
      Irreversible actions that affect the entire organization
    </Card.Description>
  </Card.Header>

  <Card.Content>
    {#if showDeleteConfirm}
      <Alert.Root variant="destructive" class="mb-4">
        <Shield class="w-4 h-4" />
        <Alert.Title>Are you absolutely sure?</Alert.Title>
        <Alert.Description>
          This action cannot be undone. This will permanently delete the organization
          and remove all members.
        </Alert.Description>
      </Alert.Root>

      <div class="flex gap-2">
        <Button variant="destructive" disabled={deleting} onclick={handleDelete}>
          <Trash2 class="w-4 h-4" />
          {deleting ? "Deleting..." : "Yes, Delete Organization"}
        </Button>
        <Button type="button" variant="outline" onclick={() => (showDeleteConfirm = false)} disabled={deleting}>
          Cancel
        </Button>
      </div>
    {:else}
      <Button variant="destructive" onclick={() => (showDeleteConfirm = true)}>
        <Trash2 class="w-4 h-4" />
        Delete Organization
      </Button>
    {/if}
  </Card.Content>
</Card.Root>
