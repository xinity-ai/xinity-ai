<script lang="ts">
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  // Error message mapping
  const errorMessages: Record<
    string,
    { title: string; description: string; suggestion: string }
  > = $derived({
    YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: {
      title: "Wrong Account",
      description: `This invitation was sent to a different email address, but you're currently signed in as ${data.userEmail}.`,
      suggestion:
        "To accept this invitation, you need to either:\n• Ask the organization to send an invitation to your current email address\n• Create a new account with the email address the invitation was sent to\n• Change your account email to match the invitation (feature coming soon)",
    },
    INVITATION_NOT_FOUND: {
      title: "Invitation Not Found",
      description:
        "The invitation you're trying to accept doesn't exist or has already been used.",
      suggestion:
        "The invitation may have been:\n• Already accepted\n• Cancelled by the organization\n• Expired\n\nPlease contact the organization administrator for a new invitation.",
    },
    INVITATION_EXPIRED: {
      title: "Invitation Expired",
      description: "This invitation has expired and can no longer be accepted.",
      suggestion:
        "Please contact the organization administrator to request a new invitation.",
    },
    ALREADY_A_MEMBER: {
      title: "Already a Member",
      description: "You're already a member of this organization.",
      suggestion:
        "You can view your organizations from the Organizations page.",
    },
  });

  const defaultError = $derived({
    title: "Error Accepting Invitation",
    description:
      data.errorMessage ||
      "An unexpected error occurred while accepting the invitation.",
    suggestion:
      "Please try again or contact the organization administrator for assistance.",
  });

  const errorInfo = $derived(data.errorCode
    ? errorMessages[data.errorCode] || defaultError
    : defaultError);
</script>

<div class="container max-w-2xl px-6 py-8 mx-auto">
  {#if data.error}
    <div class="p-8 bg-white rounded-lg shadow">
      <!-- Error Icon -->
      <div class="flex justify-center mb-6">
        <div
          class="flex items-center justify-center w-16 h-16 bg-red-100 rounded-full"
        >
          <svg
            class="w-8 h-8 text-red-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
      </div>

      <!-- Error Title -->
      <h1 class="mb-4 text-2xl font-bold text-center text-gray-900">
        {errorInfo.title}
      </h1>

      <!-- Error Description -->
      <p class="mb-6 text-center text-gray-600">
        {errorInfo.description}
      </p>

      <!-- Error Code Badge -->
      {#if data.errorCode}
        <div class="flex justify-center mb-6">
          <span
            class="px-3 py-1 text-xs font-mono text-red-800 bg-red-100 rounded-full"
          >
            Error Code: {data.errorCode}
          </span>
        </div>
      {/if}

      <!-- Suggestions -->
      <div class="p-4 mb-6 bg-xinity-magenta/10 border border-xinity-magenta/20 rounded-md">
        <h3 class="mb-2 text-sm font-semibold text-xinity-magenta">
          What you can do:
        </h3>
        <div class="text-sm text-xinity-pink whitespace-pre-line">
          {errorInfo.suggestion}
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="flex gap-3">
        <a
          href="/organizations"
          class="flex-1 px-4 py-2 text-sm font-medium text-center text-white bg-xinity-purple rounded-md hover:bg-xinity-pink"
        >
          Go to Organizations
        </a>
        <a
          href="/settings"
          class="flex-1 px-4 py-2 text-sm font-medium text-center text-xinity-magenta border border-xinity-purple rounded-md hover:bg-xinity-magenta/5"
        >
          Account Settings
        </a>
      </div>

      <!-- Technical Details (collapsible) -->
      <details class="mt-6">
        <summary
          class="text-sm font-medium text-gray-700 cursor-pointer hover:text-gray-900"
        >
          Technical Details
        </summary>
        <div
          class="p-3 mt-2 text-xs font-mono text-gray-600 bg-gray-50 rounded border border-gray-200"
        >
          <div><strong>Status Code:</strong> {data.statusCode}</div>
          <div><strong>Error Code:</strong> {data.errorCode || "N/A"}</div>
          <div><strong>Invitation ID:</strong> {data.inviteId}</div>
          <div><strong>Your Email:</strong> {data.userEmail}</div>
        </div>
      </details>
    </div>
  {:else}
    <!-- This shouldn't happen as successful acceptance redirects, but just in case -->
    <div class="p-8 text-center bg-white rounded-lg shadow">
      <div class="flex justify-center mb-4">
        <div
          class="w-12 h-12 border-4 border-xinity-purple border-t-transparent rounded-full animate-spin"
        ></div>
      </div>
      <p class="text-gray-600">Processing invitation...</p>
    </div>
  {/if}
</div>
