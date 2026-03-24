<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { permissions } from "$lib/state/permissions.svelte";
  import { toastState } from "$lib/state/toast.svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";

  let {
    organizationId,
    initialName,
    initialLogo,
    onClose,
  }: {
    organizationId: string;
    initialName: string;
    initialLogo: string;
    onClose: () => void;
  } = $props();

  // Intentional local references, to separate initial from edited
  // svelte-ignore state_referenced_locally
  let editName = $state(initialName);
  // svelte-ignore state_referenced_locally
    let editLogo = $state(initialLogo);
  let saving = $state(false);

  $effect(() => {
    editName = initialName;
    editLogo = initialLogo;
  });

  async function handleSubmit() {
    saving = true;

    const { error } = await orpc.organization.update({
      name: editName,
      logo: editLogo || undefined,
    });

    if (error) {
      toastState.add("Failed to update organization", "error");
    } else {
      await invalidateAll();
      await permissions.refresh();
      toastState.add("Organization updated", "success");
      onClose();
    }

    saving = false;
  }
</script>

<Card.Root class="mb-6">
  <Card.Header>
    <Card.Title>Edit Organization</Card.Title>
    <Card.Description>Update your organization's details</Card.Description>
  </Card.Header>
  <Card.Content>
    <form
      onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}
      class="space-y-4"
    >
      <div class="space-y-2">
        <Label for="edit-name">Organization Name</Label>
        <Input
          type="text"
          id="edit-name"
          bind:value={editName}
          required
        />
      </div>

      <div class="space-y-2">
        <Label for="edit-logo">Logo URL</Label>
        <Input
          type="url"
          id="edit-logo"
          bind:value={editLogo}
          placeholder="https://example.com/logo.png"
        />
      </div>

      <div class="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
        <Button type="button" variant="outline" onclick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  </Card.Content>
</Card.Root>
