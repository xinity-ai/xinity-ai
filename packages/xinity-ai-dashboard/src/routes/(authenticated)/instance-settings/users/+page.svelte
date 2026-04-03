<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import { page } from "$app/stores";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Card from "$lib/components/ui/card";
  import Modal from "$lib/components/Modal.svelte";
  import { roleLabels, roleBadgeVariant, type RoleName } from "$lib/roles";
  import { Search, Ban, ShieldCheck, UserPlus, X, ChevronLeft, ChevronRight, MailCheck, MailX, KeyRound, Copy, Check } from "@lucide/svelte";
  import { toastState } from "$lib/state/toast.svelte";

  let { data } = $props();

  // svelte-ignore state_referenced_locally
  let searchValue = $state(data.search);
  let searchTimeout: ReturnType<typeof setTimeout> | undefined;

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

  // Temp password copy state
  let tempPasswordCopied = $state(false);

  // Add to org modal state
  let addOrgModalOpen = $state(false);
  let addOrgTargetUser = $state<{ id: string; name: string } | null>(null);
  let addOrgSelectedOrg = $state("");
  let addOrgSelectedRole = $state<RoleName>("pending");

  function onSearchInput(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    searchValue = value;
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const url = new URL($page.url);
      if (value) {
        url.searchParams.set("search", value);
      } else {
        url.searchParams.delete("search");
      }
      url.searchParams.delete("page");
      goto(url.toString(), { replaceState: true });
    }, 300);
  }

  function goToPage(p: number) {
    const url = new URL($page.url);
    url.searchParams.set("page", String(p));
    goto(url.toString());
  }

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
      invalidateAll();
    }
  }

  async function handleUnban(userId: string, name: string) {
    const result = await orpc.instanceAdmin.unbanUser({ userId });
    if (result.error) {
      toastState.add("Failed to unban user", "error");
    } else {
      toastState.add(`Unbanned ${name}`, "success");
      invalidateAll();
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
      invalidateAll();
    }
  }

  async function handleRemoveFromOrg(userId: string, organizationId: string, userName: string) {
    const result = await orpc.instanceAdmin.removeUserFromOrganization({ userId, organizationId });
    if (result.error) {
      toastState.add(result.error.message || "Failed to remove user from organization", "error");
    } else {
      toastState.add(`Removed ${userName} from organization`, "success");
      invalidateAll();
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
      invalidateAll();
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
      invalidateAll();
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
      tempPasswordCopied = false;
      invalidateAll();
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
      tempPasswordCopied = false;
    }
  }

  async function copyTempPassword(password: string) {
    await navigator.clipboard.writeText(password);
    tempPasswordCopied = true;
    setTimeout(() => { tempPasswordCopied = false; }, 2000);
  }

  const totalPages = $derived(Math.ceil(data.total / data.limit));
</script>

<Card.Root>
  <Card.Header>
    <div class="flex items-center justify-between">
      <div>
        <Card.Title>Users</Card.Title>
        <Card.Description>{data.total} total users</Card.Description>
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
        value={searchValue}
        oninput={onSearchInput}
        class="pl-9"
      />
    </div>
  </Card.Header>
  <Card.Content>
    {#if data.users.length === 0}
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
              <th class="py-2 font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each data.users as user (user.id)}
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
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
                <td class="py-3">
                  <div class="flex items-center gap-1">
                    {#if user.banned}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Unban"
                        onclick={() => handleUnban(user.id, user.name)}
                      >
                        <ShieldCheck class="w-4 h-4" />
                      </Button>
                    {:else}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Ban"
                        onclick={() => {
                          banTargetUser = { id: user.id, name: user.name };
                          banReason = "";
                          banModalOpen = true;
                        }}
                      >
                        <Ban class="w-4 h-4" />
                      </Button>
                    {/if}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={user.emailVerified ? "Unverify email" : "Verify email"}
                      onclick={() => handleToggleEmailVerified(user.id, user.name, !!user.emailVerified)}
                    >
                      {#if user.emailVerified}
                        <MailX class="w-4 h-4" />
                      {:else}
                        <MailCheck class="w-4 h-4" />
                      {/if}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Reset password"
                      onclick={() => {
                        resetPasswordTargetUser = { id: user.id, name: user.name };
                        resetPasswordTempPassword = "";
                        tempPasswordCopied = false;
                        resetPasswordModalOpen = true;
                      }}
                    >
                      <KeyRound class="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Add to organization"
                      onclick={() => {
                        addOrgTargetUser = { id: user.id, name: user.name };
                        addOrgSelectedOrg = "";
                        addOrgSelectedRole = "pending";
                        addOrgModalOpen = true;
                      }}
                    >
                      <UserPlus class="w-4 h-4" />
                    </Button>
                  </div>
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
            Page {data.page} of {totalPages}
          </span>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={data.page <= 1}
              onclick={() => goToPage(data.page - 1)}
            >
              <ChevronLeft class="w-4 h-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={data.page >= totalPages}
              onclick={() => goToPage(data.page + 1)}
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

<!-- Ban Modal -->
<Modal bind:open={banModalOpen} onClose={() => { banModalOpen = false; }}>
  <div class="bg-card rounded-xl border shadow-2xl max-w-md w-full p-6">
    <h2 class="text-lg font-semibold mb-4">Ban {banTargetUser?.name}</h2>
    <div class="space-y-4">
      <div>
        <label for="ban-reason" class="text-sm font-medium">Reason (optional)</label>
        <Input
          id="ban-reason"
          placeholder="Reason for ban..."
          bind:value={banReason}
        />
      </div>
      <div class="flex justify-end gap-2">
        <Button variant="outline" onclick={() => { banModalOpen = false; }}>Cancel</Button>
        <Button variant="destructive" onclick={handleBan}>Ban User</Button>
      </div>
    </div>
  </div>
</Modal>

<!-- Create User Modal -->
<Modal bind:open={createUserModalOpen} onClose={() => { createUserModalOpen = false; createUserTempPassword = ""; createUserName = ""; createUserEmail = ""; }}>
  <div class="bg-card rounded-xl border shadow-2xl max-w-md w-full p-6">
    {#if createUserTempPassword}
      <h2 class="text-lg font-semibold mb-4">User Created</h2>
      <div class="space-y-4">
        <p class="text-sm text-muted-foreground">
          User <span class="font-medium text-foreground">{createUserName}</span> has been created. Give them this temporary password:
        </p>
        <div class="flex items-center gap-2">
          <code class="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono select-all">{createUserTempPassword}</code>
          <Button variant="outline" size="icon-sm" onclick={() => copyTempPassword(createUserTempPassword)}>
            {#if tempPasswordCopied}
              <Check class="w-4 h-4 text-green-600" />
            {:else}
              <Copy class="w-4 h-4" />
            {/if}
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">This password will not be shown again.</p>
        <div class="flex justify-end">
          <Button onclick={() => { createUserModalOpen = false; createUserTempPassword = ""; createUserName = ""; createUserEmail = ""; }}>Done</Button>
        </div>
      </div>
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
      <div class="space-y-4">
        <p class="text-sm text-muted-foreground">
          New temporary password for <span class="font-medium text-foreground">{resetPasswordTargetUser?.name}</span>:
        </p>
        <div class="flex items-center gap-2">
          <code class="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono select-all">{resetPasswordTempPassword}</code>
          <Button variant="outline" size="icon-sm" onclick={() => copyTempPassword(resetPasswordTempPassword)}>
            {#if tempPasswordCopied}
              <Check class="w-4 h-4 text-green-600" />
            {:else}
              <Copy class="w-4 h-4" />
            {/if}
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">This password will not be shown again.</p>
        <div class="flex justify-end">
          <Button onclick={() => { resetPasswordModalOpen = false; resetPasswordTempPassword = ""; }}>Done</Button>
        </div>
      </div>
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
        <select
          id="org-select"
          class="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
          bind:value={addOrgSelectedOrg}
        >
          <option value="">Select organization...</option>
          {#each data.organizations as org}
            <option value={org.id}>{org.name}</option>
          {/each}
        </select>
      </div>
      <div>
        <label for="role-select" class="text-sm font-medium">Role</label>
        <select
          id="role-select"
          class="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
          bind:value={addOrgSelectedRole}
        >
          {#each Object.entries(roleLabels) as [value, label]}
            {#if value !== "owner"}
              <option {value}>{label}</option>
            {/if}
          {/each}
        </select>
      </div>
      <div class="flex justify-end gap-2">
        <Button variant="outline" onclick={() => { addOrgModalOpen = false; }}>Cancel</Button>
        <Button disabled={!addOrgSelectedOrg} onclick={handleAddToOrg}>Add to Organization</Button>
      </div>
    </div>
  </div>
</Modal>
