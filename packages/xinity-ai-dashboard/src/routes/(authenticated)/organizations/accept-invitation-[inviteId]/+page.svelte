<script lang="ts">
  import type { PageData } from "./$types";
  import { goto } from "$app/navigation";
  import { organization } from "$lib/auth";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Avatar from "$lib/components/ui/avatar";

  let { data }: { data: PageData } = $props();

  type Failure = { code?: string; message?: string; status?: number };
  let acceptFailure: Failure | null = $state(null);
  let accepting = $state(false);

  const failure: Failure | null = $derived(
    acceptFailure ?? (data.error ? { code: data.errorCode, message: data.errorMessage, status: data.statusCode } : null),
  );

  async function acceptInvitation() {
    if (data.error) {
      return;
    }
    accepting = true;
    const { error } = await organization.acceptInvitation({ invitationId: data.inviteId });
    accepting = false;
    if (error) {
      acceptFailure = { code: error.code, message: error.message, status: error.status };
      return;
    }
    await goto(`/organizations/${data.invitation.organizationSlug}/`, { invalidateAll: true });
  }

  const emailNotVerified = $derived({
    title: "Email Not Verified",
    description: `Your email address ${data.userEmail} must be verified before you can accept this invitation.`,
    suggestion:
      "To verify it, either:\n• Use the link in your verification email, or request a new one from the Organizations page\n• Ask an instance administrator to mark your email as verified",
  });

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
    EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION: emailNotVerified,
    EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION: emailNotVerified,
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
      failure?.message ||
      "An unexpected error occurred while accepting the invitation.",
    suggestion:
      "Please try again or contact the organization administrator for assistance.",
  });

  const errorInfo = $derived(failure?.code
    ? errorMessages[failure.code] || defaultError
    : defaultError);
</script>

<div class="flex items-center justify-center min-h-[80vh] px-4">
  {#if failure}
    <div class="w-full max-w-2xl p-8 bg-white rounded-lg shadow">
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
      {#if failure.code}
        <div class="flex justify-center mb-6">
          <span
            class="px-3 py-1 text-xs font-mono text-red-800 bg-red-100 rounded-full"
          >
            Error Code: {failure.code}
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
          href="/organizations/"
          class="flex-1 px-4 py-2 text-sm font-medium text-center text-white bg-xinity-purple rounded-md hover:bg-xinity-purple/80 transition-colors"
        >
          Go to Organizations
        </a>
        <a
          href="/settings/"
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
          <div><strong>Status Code:</strong> {failure.status ?? "N/A"}</div>
          <div><strong>Error Code:</strong> {failure.code || "N/A"}</div>
          <div><strong>Invitation ID:</strong> {data.inviteId}</div>
          <div><strong>Your Email:</strong> {data.userEmail}</div>
        </div>
      </details>
    </div>
  {:else if !data.error}
    {@const { organizationName, organizationLogo, inviterEmail, role } = data.invitation}
    <Card.Root class="w-full max-w-md">
      <Card.Header class="justify-items-center gap-4 text-center">
        <Avatar.Root class="w-20 h-20 text-3xl">
          {#if organizationLogo}
            <Avatar.Image src={organizationLogo} alt={organizationName} />
          {/if}
          <Avatar.Fallback class="bg-primary text-primary-foreground">
            {organizationName.charAt(0).toUpperCase()}
          </Avatar.Fallback>
        </Avatar.Root>
        <Card.Title class="text-2xl">{organizationName}</Card.Title>
        <Card.Description>
          {inviterEmail} invited you to join as {role}.
        </Card.Description>
      </Card.Header>
      <Card.Footer class="flex gap-3">
        <Button variant="outline" href="/organizations/" class="flex-1">Not now</Button>
        <Button onclick={acceptInvitation} disabled={accepting} class="flex-1">
          {accepting ? "Joining..." : "Accept invitation"}
        </Button>
      </Card.Footer>
    </Card.Root>
  {/if}
</div>
