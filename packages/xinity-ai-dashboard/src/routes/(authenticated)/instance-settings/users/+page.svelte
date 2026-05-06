<script lang="ts">
  import { onMount } from "svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Card from "$lib/components/ui/card";
  import Modal from "$lib/components/Modal.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import * as Select from "$lib/components/ui/select";
  import { roleLabels, roleBadgeVariant, type RoleName } from "$lib/roles";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Search, Ban, ShieldCheck, UserPlus, X, ChevronLeft, ChevronRight, MailCheck, MailX, KeyRound, Copy, Ellipsis } from "@lucide/svelte";
  import { toastState } from "$lib/state/toast.svelte";
  import { copyToClipboard } from "$lib/copy";
  import { createUrlSearchParamsStore } from "$lib/urlSearchParamsStore";
  import { humanDateShort } from "$lib/util";

  type ListUsersData = NonNullable<Awaited<ReturnType<typeof orpc.instanceAdmin.listUsers>>["data"]>;
  type AdminUser = ListUsersData["users"][number];
  type ListOrgsData = NonNullable<Awaited<ReturnType<typeof orpc.instanceAdmin.listOrganizations>>["data"]>;
  type AdminOrganization = ListOrgsData["organizations"][number];

  const searchParams = createUrlSearchParamsStore();
  const LIMIT = 25;

  let users = $state<AdminUser[]>([]);
  let total = $state(0);
  let organizations = $state<AdminOrganization[]>([]);

  const currentPage = $derived(Number($searchParams.page) || 1);
  const searchValue = $derived($searchParams.search ?? "");

  let searchInputValue = $state($searchParams.search ?? "");
  let searchTimeout: ReturnType<typeof setTimeout> | undefined;

  async function fetchUsers() {
    const result = await orpc.instanceAdmin.listUsers({
      page: currentPage,
      limit: LIMIT,
      search: searchValue || undefined,
    });
    if (result.data) {
      users = result.data.users;
      total = result.data.total;
    }
  }

  async function fetchOrganizations() {
    const result = await orpc.instanceAdmin.listOrganizations({ page: 1, limit: 100 });
    if (result.data) {
      organizations = result.data.organizations;
    }
  }

  onMount(() => {
    void fetchUsers();
    void fetchOrganizations();
  });

  function onSearchInput(e: Event) {
    searchInputValue = (e.target as HTMLInputElement).value;
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      $searchParams.search = searchInputValue || "";
      delete $searchParams.page;
      void fetchUsers();
    }, 300);
  }

  function goToPage(p: number) {
    $searchParams.page = String(p);
    void fetchUsers();
  }

  // Ban modal state
  let banModalOpen = $state(false);
  let banTargetUser = $state<{ id: string; name: string } | null>(null);
  let banReason = $state("");

  // Create user modal state
  let createUserModalOpen = $state(false);
  let createUserName = $state("");
  let createUserEmail = $state("");
  let createUserLoading = $state(false);
  let createUserTempPassword = $state("");

  // Reset password modal state
  let resetPasswordModalOpen = $state(false);
  let resetPasswordTargetUser = $state<{ id: string; name: string } | null>(null);
  let resetPasswordLoading = $state(false);
  let resetPasswordTempPassword = $state("");

  // Add to org modal state
  let addOrgModalOpen = $state(false);
  let addOrgTargetUser = $state<{ id: string; name: string } | null>(null);
  let addOrgSelectedOrg = $state("");
  let addOrgSelectedRole = $state<RoleName>("pending");

  const addOrgOrgLabel = $derived(
    addOrgSelectedOrg === ""
      ? "Select organization..."
      : organizations.find((o) => o.id === addOrgSelectedOrg)?.name ?? "Select organization...",
  );
  const addOrgRoleLabel = $derived(roleLabels[addOrgSelectedRole] ?? "Select role...");

  async function handleBan() {
    if (!banTargetUser) return;
    const result = await orpc.instanceAdmin.banUser({
      userId: banTargetUser.id,
      reason: banReason || undefined,
    });
    if (result.error) {
      toastState.add(result.error.message || "Failed to ban user", "error");
    } else {
      toastState.add(`Banned ${banTargetUser.name}`, "success");
      banModalOpen = false;
      banReason = "";
      banTargetUser = null;
      void fetchUsers();
    }
  }

  async function handleUnban(userId: string, name: string) {
    const result = await orpc.instanceAdmin.unbanUser({ userId });
    if (result.error) {
      toastState.add("Failed to unban user", "error");
    } else {
      toastState.add(`Unbanned ${name}`, "success");
      void fetchUsers();
    }
  }

  async function handleAddToOrg() {
    if (!addOrgTargetUser || !addOrgSelectedOrg) return;
    const result = await orpc.instanceAdmin.addUserToOrganization({
      userId: addOrgTargetUser.id,
      organizationId: addOrgSelectedOrg,
      role: addOrgSelectedRole,
    });
    if (result.error) {
      toastState.add(result.error.message || "Failed to add user to organization", "error");
    } else {
      toastState.add(`Added ${addOrgTargetUser.name} to organization`, "success");
      addOrgModalOpen = false;
      addOrgTargetUser = null;
      addOrgSelectedOrg = "";
      addOrgSelectedRole = "pending";
      void fetchUsers();
    }
  }

  async function handleRemoveFromOrg(userId: string, organizationId: string, userName: string) {
    const result = await orpc.instanceAdmin.removeUserFromOrganization({ userId, organizationId });
    if (result.error) {
      toastState.add(result.error.message || "Failed to remove user from organization", "error");
    } else {
      toastState.add(`Removed ${userName} from organization`, "success");
      void fetchUsers();
    }
  }

  async function handleRoleChange(userId: string, organizationId: string, role: string) {
    const result = await orpc.instanceAdmin.updateUserRole({
      userId,
      organizationId,
      role: role as RoleName,
    });
    if (result.error) {
      toastState.add(result.error.message || "Failed to update role", "error");
    } else {
      toastState.add("Role updated", "success");
      void fetchUsers();
    }
  }

  async function handleToggleEmailVerified(userId: string, name: string, currentlyVerified: boolean) {
    const result = await orpc.instanceAdmin.setEmailVerified({
      userId,
      verified: !currentlyVerified,
    });
    if (result.error) {
      toastState.add(result.error.message || "Failed to update verification status", "error");
    } else {
      toastState.add(`${!currentlyVerified ? "Verified" : "Unverified"} email for ${name}`, "success");
      void fetchUsers();
    }
  }

  async function handleCreateUser() {
    if (!createUserName || !createUserEmail) return;
    createUserLoading = true;
    const result = await orpc.instanceAdmin.createUser({
      name: createUserName,
      email: createUserEmail,
    });
    createUserLoading = false;
    if (result.error) {
      toastState.add(result.error.message || "Failed to create user", "error");
    } else {
      createUserTempPassword = result.data.temporaryPassword;
      void fetchUsers();
    }
  }

  async function handleResetPassword() {
    if (!resetPasswordTargetUser) return;
    resetPasswordLoading = true;
    const result = await orpc.instanceAdmin.resetUserPassword({
      userId: resetPasswordTargetUser.id,
    });
    resetPasswordLoading = false;
    if (result.error) {
      toastState.add(result.error.message || "Failed to reset password", "error");
    } else {
      resetPasswordTempPassword = result.data.temporaryPassword;
    }
  }

  const totalPages = $derived(Math.ceil(total / LIMIT));
</script>

<Card.Root>
  <Card.Header>
    <div class="flex items-center justify-between">
      <div>
        <Card.Title>Users</Card.Title>
        <Card.Description>{total} total users</Card.Description>
      </div>
      <Button onclick={() => { createUserModalOpen = true; }}>
        <UserPlus class="w-4 h-4 mr-2" />
        Create User
      </Button>
    </div>
    <div class="relative mt-4">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
      <Input
        placeholder="Search by name or email..."
        value={searchInputValue}
        oninput={onSearchInput}
        class="pl-9"
      />
    </div>
  </Card.Header>
  <Card.Content>
    {#if users.length === 0}
      <p class="text-center text-muted-foreground py-8">No users found.</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b text-left">
              <th class="py-2 pr-4 font-medium text-muted-foreground">Name</th>
              <th class="py-2 pr-4 font-medium text-muted-foreground">Email</th>
              <th class="py-2 pr-4 font-medium text-muted-foreground">Status</th>
              <th class="py-2 pr-4 font-medium text-muted-foreground">Organizations</th>
              <th class="py-2 pr-4 font-medium text-muted-foreground">Created</th>
              <th class="py-2 font-medium text-muted-foreground w-10"></th>
            </tr>
          </thead>
          <tbody>
            {#each users as user (user.id)}
              <tr class="border-b last:border-0">
                <td class="py-3 pr-4 font-medium">{user.name}</td>
                <td class="py-3 pr-4 text-muted-foreground">{user.email}</td>
                <td class="py-3 pr-4">
                  <div class="flex flex-wrap gap-1">
                    {#if user.banned}
                      <Badge variant="destructive">Banned</Badge>
                    {:else}
                      <Badge variant="outline">Active</Badge>
                    {/if}
                    {#if user.emailVerified}
                      <Badge variant="outline" class="text-green-600 border-green-600/30">Verified</Badge>
                    {:else}
                      <Badge variant="secondary">Unverified</Badge>
                    {/if}
                  </div>
                </td>
                <td class="py-3 pr-4">
                  <div class="flex flex-wrap gap-1">
                    {#each user.memberships as m}
                      <span class="inline-flex items-center gap-1">
                        <Badge variant={roleBadgeVariant[m.role as RoleName] ?? "outline"}>
                          {m.organizationName}: {roleLabels[m.role as RoleName] ?? m.role}
                        </Badge>
                        <button
                          class="text-muted-foreground hover:text-destructive"
                          title="Remove from {m.organizationName}"
                          onclick={() => handleRemoveFromOrg(user.id, m.organizationId, user.name)}
                        >
                          <X class="w-3 h-3" />
                        </button>
                      </span>
                    {:else}
                      <span class="text-muted-foreground text-xs">No organizations</span>
                    {/each}
                  </div>
                </td>
                <td class="py-3 pr-4 text-muted-foreground text-xs whitespace-nowrap">
                  {humanDateShort(user.createdAt)}
                </td>
                <td class="py-3">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                      {#snippet child({ props })}
                        <Button variant="ghost" size="icon-sm" {...props}>
                          <Ellipsis class="w-4 h-4" />
                        </Button>
                      {/snippet}
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="end" class="w-48">
                        {#if user.banned}
                          <DropdownMenu.Item onclick={() => handleUnban(user.id, user.name)}>
                            <ShieldCheck class="w-4 h-4 mr-2" />
                            Unban
                          </DropdownMenu.Item>
                        {:else}
                          <DropdownMenu.Item onclick={() => {
                            banTargetUser = { id: user.id, name: user.name };
                            banReason = "";
                            banModalOpen = true;
                          }}>
                            <Ban class="w-4 h-4 mr-2" />
                            Ban
                          </DropdownMenu.Item>
                        {/if}
                        <DropdownMenu.Item onclick={() => handleToggleEmailVerified(user.id, user.name, !!user.emailVerified)}>
                          {#if user.emailVerified}
                            <MailX class="w-4 h-4 mr-2" />
                            Unverify email
                          {:else}
                            <MailCheck class="w-4 h-4 mr-2" />
                            Verify email
                          {/if}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onclick={() => {
                          resetPasswordTargetUser = { id: user.id, name: user.name };
                          resetPasswordTempPassword = "";
                          resetPasswordModalOpen = true;
                        }}>
                          <KeyRound class="w-4 h-4 mr-2" />
                          Reset password
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item onclick={() => {
                          addOrgTargetUser = { id: user.id, name: user.name };
                          addOrgSelectedOrg = "";
                          addOrgSelectedRole = "pending";
                          addOrgModalOpen = true;
                        }}>
                          <UserPlus class="w-4 h-4 mr-2" />
                          Add to organization
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      {#if totalPages > 1}
        <div class="flex items-center justify-between mt-4 pt-4 border-t">
          <span class="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages}
          </span>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage <= 1}
              onclick={() => goToPage(currentPage - 1)}
            >
              <ChevronLeft class="w-4 h-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages}
              onclick={() => goToPage(currentPage + 1)}
            >
              Next
              <ChevronRight class="w-4 h-4" />
            </Button>
          </div>
        </div>
      {/if}
    {/if}
  </Card.Content>
</Card.Root>

{#snippet tempPasswordDisplay(password: string, description: string, onDone: () => void)}
  <div class="space-y-4">
    <p class="text-sm text-muted-foreground">{@html description}</p>
    <div class="flex items-center gap-2">
      <code class="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono select-all">{password}</code>
      <Button variant="outline" size="icon-sm" onclick={() => copyToClipboard(password)}>
        <Copy class="w-4 h-4" />
      </Button>
    </div>
    <p class="text-xs text-muted-foreground">This password will not be shown again.</p>
    <div class="flex justify-end">
      <Button onclick={onDone}>Done</Button>
    </div>
  </div>
{/snippet}

<!-- Ban Modal -->
<ConfirmDialog
  bind:open={banModalOpen}
  title="Ban {banTargetUser?.name}"
  confirmLabel="Ban User"
  onConfirm={handleBan}
  onCancel={() => { banReason = ""; banTargetUser = null; }}
>
  <div>
    <label for="ban-reason" class="text-sm font-medium">Reason (optional)</label>
    <Input
      id="ban-reason"
      placeholder="Reason for ban..."
      bind:value={banReason}
    />
  </div>
</ConfirmDialog>

<!-- Create User Modal -->
<Modal bind:open={createUserModalOpen} onClose={() => { createUserModalOpen = false; createUserTempPassword = ""; createUserName = ""; createUserEmail = ""; }}>
  <div class="bg-card rounded-xl border shadow-2xl max-w-md w-full p-6">
    {#if createUserTempPassword}
      <h2 class="text-lg font-semibold mb-4">User Created</h2>
      {@render tempPasswordDisplay(
        createUserTempPassword,
        `User <span class="font-medium text-foreground">${createUserName}</span> has been created. Give them this temporary password:`,
        () => { createUserModalOpen = false; createUserTempPassword = ""; createUserName = ""; createUserEmail = ""; },
      )}
    {:else}
      <h2 class="text-lg font-semibold mb-4">Create User</h2>
      <div class="space-y-4">
        <div>
          <label for="create-name" class="text-sm font-medium">Name</label>
          <Input id="create-name" placeholder="Full name" bind:value={createUserName} />
        </div>
        <div>
          <label for="create-email" class="text-sm font-medium">Email</label>
          <Input id="create-email" type="email" placeholder="user@example.com" bind:value={createUserEmail} />
        </div>
        <p class="text-xs text-muted-foreground">A temporary password will be generated for you to share with the user.</p>
        <div class="flex justify-end gap-2">
          <Button variant="outline" onclick={() => { createUserModalOpen = false; }}>Cancel</Button>
          <Button
            disabled={!createUserName || !createUserEmail || createUserLoading}
            onclick={handleCreateUser}
          >
            {createUserLoading ? "Creating..." : "Create User"}
          </Button>
        </div>
      </div>
    {/if}
  </div>
</Modal>

<!-- Reset Password Modal -->
<Modal bind:open={resetPasswordModalOpen} onClose={() => { resetPasswordModalOpen = false; resetPasswordTempPassword = ""; }}>
  <div class="bg-card rounded-xl border shadow-2xl max-w-md w-full p-6">
    {#if resetPasswordTempPassword}
      <h2 class="text-lg font-semibold mb-4">Password Reset</h2>
      {@render tempPasswordDisplay(
        resetPasswordTempPassword,
        `New temporary password for <span class="font-medium text-foreground">${resetPasswordTargetUser?.name}</span>:`,
        () => { resetPasswordModalOpen = false; resetPasswordTempPassword = ""; },
      )}
    {:else}
      <h2 class="text-lg font-semibold mb-4">Reset Password</h2>
      <div class="space-y-4">
        <p class="text-sm text-muted-foreground">
          Generate a new temporary password for <span class="font-medium text-foreground">{resetPasswordTargetUser?.name}</span>? Their current password will stop working immediately.
        </p>
        <div class="flex justify-end gap-2">
          <Button variant="outline" onclick={() => { resetPasswordModalOpen = false; }}>Cancel</Button>
          <Button
            disabled={resetPasswordLoading}
            onclick={handleResetPassword}
          >
            {resetPasswordLoading ? "Resetting..." : "Reset Password"}
          </Button>
        </div>
      </div>
    {/if}
  </div>
</Modal>

<!-- Add to Organization Modal -->
<Modal bind:open={addOrgModalOpen} onClose={() => { addOrgModalOpen = false; }}>
  <div class="bg-card rounded-xl border shadow-2xl max-w-md w-full p-6">
    <h2 class="text-lg font-semibold mb-4">Add {addOrgTargetUser?.name} to Organization</h2>
    <div class="space-y-4">
      <div>
        <label for="org-select" class="text-sm font-medium">Organization</label>
        <Select.Root type="single" bind:value={addOrgSelectedOrg}>
          <Select.Trigger id="org-select" class="w-full mt-1">
            {addOrgOrgLabel}
          </Select.Trigger>
          <Select.Content portalProps={{ disabled: true }}>
            <Select.Item value="" label="Select organization..." />
            {#each organizations as org}
              <Select.Item value={org.id} label={org.name} />
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div>
        <label for="role-select" class="text-sm font-medium">Role</label>
        <Select.Root type="single" bind:value={addOrgSelectedRole}>
          <Select.Trigger id="role-select" class="w-full mt-1">
            {addOrgRoleLabel}
          </Select.Trigger>
          <Select.Content portalProps={{ disabled: true }}>
            {#each Object.entries(roleLabels) as [value, label]}
              {#if value !== "owner"}
                <Select.Item {value} {label} />
              {/if}
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex justify-end gap-2">
        <Button variant="outline" onclick={() => { addOrgModalOpen = false; }}>Cancel</Button>
        <Button disabled={!addOrgSelectedOrg} onclick={handleAddToOrg}>Add to Organization</Button>
      </div>
    </div>
  </div>
</Modal>
