<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { permissions } from "$lib/state/permissions.svelte";
  import { toastState } from "$lib/state/toast.svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { humanDate } from "$lib/util";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Avatar from "$lib/components/ui/avatar";
  import { Badge } from "$lib/components/ui/badge";
  import { X, Mail } from "@lucide/svelte";
  import { roleLabels } from "$lib/roles";

  type Invitation = {
    id: string;
    email: string;
    role: string;
    status: string;
    expiresAt: Date;
  };

  let {
    invitations,
    readOnly = false,
  }: {
    invitations: Invitation[];
    readOnly?: boolean;
  } = $props();

  const pendingInvitations = $derived(invitations.filter(i => i.status === "pending"));

  let cancellingIds = $state<Set<string>>(new Set());

  async function handleCancel(invitationId: string) {
    cancellingIds = new Set([...cancellingIds, invitationId]);

    const { error } = await orpc.organization.cancelInvitation({ invitationId });

    if (error) {
      toastState.add("Failed to cancel invitation", "error");
    } else {
      await invalidateAll();
      await permissions.refresh();
      toastState.add("Invitation cancelled", "success");
    }

    cancellingIds = new Set([...cancellingIds].filter(id => id !== invitationId));
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Pending Invitations</Card.Title>
    <Card.Description>
      Invitations that haven't been accepted yet
    </Card.Description>
  </Card.Header>

  <Card.Content>
    {#if pendingInvitations.length > 0}
      <div class="space-y-2">
        {#each pendingInvitations as invitation}
          <div class="flex items-center justify-between p-3 rounded-lg border bg-card">
            <div class="flex items-center gap-3">
              <Avatar.Root class="w-9 h-9">
                <Avatar.Fallback class="text-xs bg-muted">
                  <Mail class="w-4 h-4" />
                </Avatar.Fallback>
              </Avatar.Root>
              <div>
                <p class="font-medium">{invitation.email}</p>
                <p class="text-xs text-muted-foreground">
                  Expires {humanDate(invitation.expiresAt)}
                </p>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <Badge variant="outline">
                {roleLabels[invitation.role as keyof typeof roleLabels] || invitation.role}
              </Badge>
              {#if !readOnly}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-destructive hover:text-destructive"
                  disabled={cancellingIds.has(invitation.id)}
                  onclick={() => handleCancel(invitation.id)}
                >
                  <X class="w-4 h-4" />
                </Button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <p class="py-4 text-sm text-center text-muted-foreground">No pending invitations.</p>
    {/if}
  </Card.Content>
</Card.Root>
