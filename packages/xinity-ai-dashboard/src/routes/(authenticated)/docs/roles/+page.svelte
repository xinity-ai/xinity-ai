<script lang="ts">
  import RolesPermissionMatrix from "$lib/components/RolesPermissionMatrix.svelte";
</script>

<svelte:head>
  <title>Roles & Permissions - Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <nav class="mb-6">
    <a
      href="/docs/"
      class="text-blue-600 hover:text-blue-800 flex items-center gap-2"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4"
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z"
          clip-rule="evenodd"
        />
      </svg>
      All Docs
    </a>
  </nav>

  <h1 class="mb-4 text-4xl font-bold">Roles & Permissions</h1>
  <p class="mb-8 text-lg text-gray-600">
    Understand what each role can do and how to manage team access within your organization.
  </p>

  <!-- Overview -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Overview</h2>
    <p class="text-gray-600 mb-4">
      Every member of an organization is assigned one of six roles. Roles control which resources a
      member can view and modify. They are set when inviting someone and can be changed afterwards by
      owners and admins.
    </p>
    <ul class="list-disc pl-6 space-y-2 text-gray-600">
      <li>Roles are scoped to an organization; the same user can have different roles in different organizations.</li>
      <li>Only <strong>owners</strong> and <strong>admins</strong> can invite members and change roles.</li>
      <li>Owners can assign any role. Admins can assign member, labeler, and viewer.</li>
    </ul>
  </section>

  <!-- Permission Matrix -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-6">Roles & Permission Matrix</h2>
    <RolesPermissionMatrix />
  </section>

  <!-- Managing members -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Managing Members</h2>
    <p class="text-gray-600 mb-4">
      To invite members or change roles, navigate to your organization's settings page.
    </p>
    <ol class="list-decimal pl-6 space-y-2 text-gray-600">
      <li>Go to <a href="/organizations/" class="text-blue-600 hover:text-blue-800 underline">Organizations</a> and select your organization.</li>
      <li>In the <strong>Members</strong> section, click <strong>Invite member</strong> to add someone new.</li>
      <li>To change an existing member's role, click the role badge next to their name and select a new role.</li>
    </ol>
  </section>
</div>
