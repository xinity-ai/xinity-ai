<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { permissions } from "$lib/state/permissions.svelte";
  import { toastState } from "$lib/state/toast.svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Select from "$lib/components/ui/select";
  import * as Avatar from "$lib/components/ui/avatar";
  import { Badge } from "$lib/components/ui/badge";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Separator } from "$lib/components/ui/separator";
  import { UserPlus, X, Mail, Info } from "@lucide/svelte";
  import Modal from "$lib/components/Modal.svelte";
  import {
    getInitials,
    getAvailableRoles,
  } from "./organization-utils";
  import { roleLabels, roleBadgeVariant, type RoleName } from "$lib/roles";

  type Member = {
    id: string;
    role: RoleName;
    user?: {
      name?: string | null;
      email?: string | null;
    } | null;
  };

  let {
    organizationId,
    members,
    canInvite,
    canRemove,
    canChangeRoles,
    activeRole,
    onOpenRolesInfo,
  }: {
    organizationId: string;
    members: Member[];
    canInvite: boolean;
    canRemove: boolean;
    canChangeRoles: boolean;
    activeRole: RoleName;
    onOpenRolesInfo?: () => void;
  } = $props();

  let showInviteForm = $state(false);
  let inviteEmail = $state("");
  let inviteRole: RoleName = $state("member");
  let inviting = $state(false);

  // Optimistic state for member role changes
  let memberRoleOverrides = $state<Record<string, RoleName>>({});
  let savingMemberIds = $state<Set<string>>(new Set());
  let memberToRemove = $state<Member | null>(null);
  let isRemoving = $state(false);

  const availableRoles = $derived(getAvailableRoles(activeRole));
  const inviteRoleLabel = $derived(roleLabels[inviteRole] || "Select role");

  function getMemberRole(memberId: string, actualRole: RoleName): RoleName {
    return memberRoleOverrides[memberId] ?? actualRole;
  }

  async function handleInvite() {
    inviting = true;

    const { error } = await orpc.organization.inviteMember({
      email: inviteEmail,
      role: inviteRole,
    });

    if (error) {
      toastState.add("Failed to send invitation", "error");
    } else {
      await invalidateAll();
      await permissions.refresh();
      toastState.add("Invitation sent", "success");
      showInviteForm = false;
      inviteEmail = "";
      inviteRole = "member";
    }

    inviting = false;
  }

  async function handleRemoveMember() {
    if (!memberToRemove) return;
    isRemoving = true;

    const { error } = await orpc.organization.removeMember({
      memberId: memberToRemove.id,
    });

    if (error) {
      toastState.add("Failed to remove member", "error");
    } else {
      await invalidateAll();
      await permissions.refresh();
      toastState.add("Member removed", "success");
      memberToRemove = null;
    }

    isRemoving = false;
  }

  async function handleRoleChange(memberId: string, newRole: RoleName) {
    memberRoleOverrides[memberId] = newRole;
    savingMemberIds = new Set([...savingMemberIds, memberId]);

    const { error } = await orpc.organization.updateMemberRole({
      memberId,
      role: newRole,
    });

    if (error) {
      delete memberRoleOverrides[memberId];
      toastState.add("Failed to update role", "error");
    } else {
      await invalidateAll();
      await permissions.refresh();
      toastState.add(`Role updated to ${roleLabels[newRole]}`, "success");
      delete memberRoleOverrides[memberId];
    }

    savingMemberIds = new Set(
      [...savingMemberIds].filter((id) => id !== memberId),
    );
  }
</script>

<Card.Root>
  <Card.Header>
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <div>
          <Card.Title>Members</Card.Title>
          <Card.Description>
            {members.length} member{members.length !== 1 ? "s" : ""}
          </Card.Description>
        </div>
        {#if onOpenRolesInfo}
          <Button variant="ghost" size="icon-sm" onclick={onOpenRolesInfo} title="View role permissions">
            <Info class="w-4 h-4" />
          </Button>
        {/if}
      </div>
      {#if canInvite}
        <Button size="sm" onclick={() => (showInviteForm = !showInviteForm)}>
          <UserPlus class="w-4 h-4" />
          Invite
        </Button>
      {/if}
    </div>
  </Card.Header>

  <Card.Content class="space-y-4 compact:space-y-2">
    {#if showInviteForm}
      <form
        onsubmit={(e) => { e.preventDefault(); handleInvite(); }}
        class="p-4 compact:p-3 space-y-4 compact:space-y-2 border rounded-lg bg-muted/30"
      >
        <div class="grid gap-4 compact:gap-2 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="invite-email">Email Address</Label>
            <Input
              type="email"
              id="invite-email"
              bind:value={inviteEmail}
              required
              placeholder="user@example.com"
            />
          </div>

          <div class="space-y-2">
            <Label for="invite-role">Role</Label>
            <Select.Root type="single" bind:value={inviteRole}>
              <Select.Trigger class="w-full">
                {inviteRoleLabel}
              </Select.Trigger>
              <Select.Content>
                {#each availableRoles as role}
                  <Select.Item value={role} label={roleLabels[role]} />
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        </div>

        <div class="flex gap-2 compact:gap-1.5">
          <Button type="submit" size="sm" disabled={inviting}>
            <Mail class="w-4 h-4" />
            {inviting ? "Sending..." : "Send Invitation"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onclick={() => (showInviteForm = false)}
          >
            Cancel
          </Button>
        </div>
      </form>

      <Separator />
    {/if}

    {#if members.length > 0}
      <div class="space-y-2 compact:space-y-1">
        {#each members as member}
          <div
            class="flex items-center justify-between p-3 compact:p-2 rounded-lg border bg-card hover:bg-muted/30 transition-colors"
          >
            <div class="flex items-center gap-3 compact:gap-2">
              <Avatar.Root class="w-9 h-9 compact:w-7 compact:h-7">
                <Avatar.Fallback class="text-xs">
                  {getInitials(member.user?.name, member.user?.email)}
                </Avatar.Fallback>
              </Avatar.Root>
              <div class="min-w-0">
                <p class="font-medium truncate">
                  {member.user?.name || member.user?.email}
                </p>
                {#if member.user?.name}
                  <p class="text-sm text-muted-foreground truncate">
                    {member.user?.email}
                  </p>
                {/if}
              </div>
            </div>

            <div class="flex items-center gap-2 compact:gap-1">
              {#if canChangeRoles && member.role !== "owner"}
                {@const effectiveRole = getMemberRole(member.id, member.role)}
                {@const isSaving = savingMemberIds.has(member.id)}
                <div class="flex items-center">
                  <Select.Root
                    type="single"
                    value={effectiveRole}
                    disabled={isSaving}
                    onValueChange={(v) => {
                      if (v && v !== effectiveRole) {
                        handleRoleChange(member.id, v as RoleName);
                      }
                    }}
                  >
                    <Select.Trigger
                      class="h-8 px-2 text-xs min-w-25 border rounded-md bg-background focus:ring-0"
                    >
                      {roleLabels[effectiveRole] || effectiveRole}
                    </Select.Trigger>
                    <Select.Content>
                      {#each availableRoles as role}
                        <Select.Item value={role} label={roleLabels[role]} />
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>
              {:else}
                <Badge variant={roleBadgeVariant[member.role] || "secondary"}>
                  {roleLabels[member.role] || member.role}
                </Badge>
              {/if}

              {#if canRemove && member.role !== "owner"}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onclick={() => (memberToRemove = member)}
                >
                  <X class="w-4 h-4" />
                </Button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <p class="py-4 text-sm text-center text-muted-foreground">
        No members yet.
      </p>
    {/if}
  </Card.Content>
</Card.Root>

<Modal open={Boolean(memberToRemove)} onClose={() => (memberToRemove = null)}>
  <div
    class="p-6 compact:p-4 bg-card rounded-xl border shadow-2xl max-w-md w-full animate-in fade-in zoom-in duration-200"
  >
    <div class="flex items-center gap-3 compact:gap-2 mb-4 compact:mb-3">
      <div class="p-2 rounded-full bg-destructive/10 text-destructive">
        <X class="w-6 h-6 compact:w-5 compact:h-5" />
      </div>
      <h3 class="text-xl compact:text-lg font-semibold">Remove Member</h3>
    </div>

    <p class="text-muted-foreground mb-6 compact:mb-3">
      Are you sure you want to remove <span
        class="font-semibold text-foreground"
        >{memberToRemove?.user?.name || memberToRemove?.user?.email}</span
      >? They will lose all access to this organization immediately.
    </p>

    <div class="flex justify-end gap-3 compact:gap-2">
      <Button
        variant="outline"
        onclick={() => (memberToRemove = null)}
        disabled={isRemoving}
      >
        Cancel
      </Button>
      <Button variant="destructive" disabled={isRemoving} onclick={handleRemoveMember}>
        {#if isRemoving}
          Removing...
        {:else}
          Remove Member
        {/if}
      </Button>
    </div>
  </div>
</Modal>
