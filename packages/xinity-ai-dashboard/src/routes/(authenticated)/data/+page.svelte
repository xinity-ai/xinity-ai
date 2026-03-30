<script lang="ts">
  import type { PageData } from "./$types";
  import { orpc } from "$lib/orpc/orpc-client";
  import { updateOptimistically } from "$lib/util";
  import Modal from "$lib/components/Modal.svelte";
  import { toastState } from "$lib/state/toast.svelte";
  import type { ApplicationDto } from "$lib/orpc/dtos/application.dto";
  import { permissions } from "$lib/state/permissions.svelte";
  import NoOrganization from "$lib/components/NoOrganization.svelte";

  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Archive, ArrowRight, Plus, Pencil, Trash2 } from "@lucide/svelte";

  let { data }: { data: PageData } = $props();
  let applications = $state(data.applications as ApplicationDto[]);

  // Resync when page data changes (e.g. on navigation)
  $effect(() => {
    applications = data.applications as ApplicationDto[];
  });

  // --- Edit state ---
  let editingApp: {
    id: string;
    name: string;
    description: string | null;
  } | null = $state(null);

  function editApplication(app: ApplicationDto) {
    editingApp = {
      id: app.id,
      name: app.name,
      description: app.description || "",
    };
  }

  function cancelEditApp() {
    editingApp = null;
  }

  async function saveApplication() {
    if (!editingApp) return;

    const appBefore = applications.find((a) => a.id === editingApp!.id);
    const updatedApp = { ...editingApp };

    await updateOptimistically({
      apiPromise: () =>
        orpc.application.update({
          id: editingApp!.id,
          name: editingApp!.name,
          description: editingApp!.description || null,
        }),
      update: () => {
        applications = applications.map((a) =>
          a.id === updatedApp.id
            ? { ...a, name: updatedApp.name, description: updatedApp.description || null }
            : a,
        );
      },
      undo: () => {
        if (appBefore) {
          applications = applications.map((a) =>
            a.id === appBefore.id
              ? { ...a, name: appBefore.name, description: appBefore.description }
              : a,
          );
        }
        toastState.add("Failed to update application", "error");
      },
    });

    editingApp = null;
    toastState.add("Application updated successfully", "success");
  }

  // --- Delete state ---
  let showDeleteModal = $state(false);
  let applicationToDelete: ApplicationDto | null = $state(null);

  function requestDeleteApp(app: ApplicationDto) {
    applicationToDelete = app;
    showDeleteModal = true;
  }

  function cancelDeleteApp() {
    applicationToDelete = null;
    showDeleteModal = false;
  }

  async function confirmDeleteApp() {
    if (!applicationToDelete) return;
    const deletingApp = applicationToDelete;
    applicationToDelete = null;
    showDeleteModal = false;
    let failed = false;

    const applicationsBefore = applications;

    await updateOptimistically({
      apiPromise: () => orpc.application.softDelete({ id: deletingApp.id }),
      update: () => {
        applications = applications.filter((a) => a.id !== deletingApp.id);
      },
      undo: () => {
        applications = applicationsBefore;
        failed = true;
        toastState.add("Error deleting application", "error");
      },
    });

    if (!failed) {
      toastState.add(`Deleted application "${deletingApp.name}"`, "success");
    }
  }

  // --- Create state ---
  let showCreateModal = $state(false);
  let newApp: { name: string; description: string } = $state({
    name: "",
    description: "",
  });

  function openCreateModal() {
    newApp = { name: "", description: "" };
    showCreateModal = true;
  }

  function cancelCreate() {
    showCreateModal = false;
    newApp = { name: "", description: "" };
  }

  async function createApplication() {
    if (!newApp.name.trim()) {
      toastState.add("Application name is required", "error");
      return;
    }

    const { error, data: createdApp } = await orpc.application.create({
      name: newApp.name,
      description: newApp.description || null,
    });

    if (error) {
      console.error(error);
      toastState.add("Failed to create application", "error");
      return;
    }

    applications = [...applications, createdApp];
    toastState.add(`Created application "${createdApp.name}"`, "success");
    showCreateModal = false;
    newApp = { name: "", description: "" };
  }
</script>

<svelte:head>
  <title>Data Management</title>
</svelte:head>

{#if !data.activeOrganizationId}
  <NoOrganization />
{:else}
<div class="container px-4 py-8 compact:py-4 mx-auto">
  <div class="max-w-4xl mx-auto">
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-3xl font-bold">Data Management</h1>
      {#if permissions.can("aiApplication", "create")}
        <Button onclick={openCreateModal}>
          <Plus class="w-4 h-4" />
          Create Application
        </Button>
      {/if}
    </div>
    <p class="mb-8 compact:mb-4 text-muted-foreground">
      Select an application to view its user-generated data, analysis, and
      improvements.
    </p>

    {#if applications.length === 0 && !data.uncategorizedCount}
      <Card.Root class="p-12">
        <div class="flex flex-col items-center text-center">
          <Archive class="w-12 h-12 mb-4 text-muted-foreground" />
          <h2 class="text-xl font-semibold mb-2">No applications found</h2>
          <p class="text-muted-foreground mb-6">
            You need to create an application and generate an API key before you
            can view data.
          </p>
          {#if permissions.can("aiApplication", "create")}
            <Button onclick={openCreateModal}>
              <Plus class="w-4 h-4" />
              Create Application
            </Button>
          {/if}
        </div>
      </Card.Root>
    {:else}
      <div class="grid grid-cols-1 gap-6 compact:gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {#each applications as app}
          <a href="/data/{app.id}/" class="block group">
            <Card.Root class="h-full transition-all duration-200 hover:shadow-md hover:border-primary/50">
              <Card.Header>
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <Card.Title>{app.name}</Card.Title>
                    <Card.Description class="line-clamp-2 min-h-10">
                      {app.description || "No description provided."}
                    </Card.Description>
                  </div>
                  <div class="flex gap-1 shrink-0">
                    {#if permissions.can("aiApplication", "update")}
                      <Button
                        variant="ghost"
                        size="icon"
                        class="h-7 w-7"
                        onclick={(e) => { e.preventDefault(); e.stopPropagation(); editApplication(app); }}
                      >
                        <Pencil class="w-3.5 h-3.5" />
                      </Button>
                    {/if}
                    {#if permissions.can("aiApplication", "delete")}
                      <Button
                        variant="ghost"
                        size="icon"
                        class="h-7 w-7 text-destructive hover:text-destructive"
                        onclick={(e) => { e.preventDefault(); e.stopPropagation(); requestDeleteApp(app); }}
                      >
                        <Trash2 class="w-3.5 h-3.5" />
                      </Button>
                    {/if}
                  </div>
                </div>
              </Card.Header>
              <Card.Footer>
                <span class="flex items-center text-sm font-medium text-primary group-hover:underline">
                  View Data
                  <ArrowRight class="w-4 h-4 ml-1" />
                </span>
              </Card.Footer>
            </Card.Root>
          </a>
        {/each}

        {#if data.uncategorizedCount > 0}
          <a href="/data/uncategorized/" class="block group">
            <Card.Root class="h-full transition-all duration-200 hover:shadow-md hover:border-primary/50 border-dashed">
              <Card.Header>
                <Card.Title>Uncategorized</Card.Title>
                <Card.Description class="line-clamp-2 min-h-10">
                  {data.uncategorizedCount} call{data.uncategorizedCount === 1 ? "" : "s"} without an application assignment.
                </Card.Description>
              </Card.Header>
              <Card.Footer>
                <span class="flex items-center text-sm font-medium text-primary group-hover:underline">
                  View Data
                  <ArrowRight class="w-4 h-4 ml-1" />
                </span>
              </Card.Footer>
            </Card.Root>
          </a>
        {/if}
      </div>
    {/if}
  </div>
</div>

<!-- Edit Application Modal -->
{#if editingApp}
  <Modal open={true} onClose={cancelEditApp}>
    <form
      onsubmit={(e) => { e.preventDefault(); saveApplication(); }}
      class="w-full max-w-md p-6 bg-card rounded-xl shadow-2xl space-y-4"
      data-appid={editingApp.id}
    >
      <h3 class="text-lg font-semibold">Edit Application</h3>

      <div class="space-y-2">
        <Label for="appName">Application Name</Label>
        <Input
          type="text"
          id="appName"
          bind:value={editingApp.name}
          required
        />
      </div>

      <div class="space-y-2">
        <Label for="appDescription">Description</Label>
        <textarea
          id="appDescription"
          rows="3"
          class="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          bind:value={editingApp.description}
        ></textarea>
      </div>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" onclick={cancelEditApp}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  </Modal>
{/if}

<!-- Delete Application Modal -->
<Modal open={showDeleteModal} onClose={cancelDeleteApp}>
  <div class="w-full max-w-md p-6 bg-card rounded-xl shadow-2xl space-y-4">
    <div>
      <h3 class="text-lg font-semibold">Delete Application</h3>
      <p class="text-sm text-muted-foreground mt-2">
        Are you sure you want to delete
        <span class="font-semibold text-foreground">
          {applicationToDelete?.name ?? "this application"}
        </span>? This will not delete associated API keys, but they will become inaccessible.
      </p>
    </div>
    <div class="flex justify-end gap-2">
      <Button variant="outline" onclick={cancelDeleteApp}>
        Cancel
      </Button>
      <Button variant="destructive" onclick={confirmDeleteApp}>
        Delete
      </Button>
    </div>
  </div>
</Modal>

<!-- Create Application Modal -->
<Modal open={showCreateModal} onClose={cancelCreate}>
  <form
    onsubmit={(e) => { e.preventDefault(); createApplication(); }}
    class="w-full max-w-md p-6 bg-card rounded-xl shadow-2xl space-y-4"
  >
    <h3 class="text-lg font-semibold">Create Application</h3>

    <div class="space-y-2">
      <Label for="newAppName">Application Name</Label>
      <Input
        type="text"
        id="newAppName"
        bind:value={newApp.name}
        placeholder="e.g., Customer Chatbot, Doc Summarizer"
        required
      />
    </div>

    <div class="space-y-2">
      <Label for="newAppDescription">Description (optional)</Label>
      <textarea
        id="newAppDescription"
        rows="3"
        class="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        bind:value={newApp.description}
        placeholder="Describe the purpose of this application..."
      ></textarea>
    </div>

    <div class="flex justify-end gap-2">
      <Button type="button" variant="outline" onclick={cancelCreate}>
        Cancel
      </Button>
      <Button type="submit">Create</Button>
    </div>
  </form>
</Modal>
{/if}
