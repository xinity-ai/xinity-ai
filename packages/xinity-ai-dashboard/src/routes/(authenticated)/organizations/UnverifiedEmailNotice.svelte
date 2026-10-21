<script lang="ts">
  import { sendVerificationEmail } from "$lib/auth";
  import { toastState } from "$lib/state/toast.svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { MailWarning } from "@lucide/svelte";

  let {
    email,
    mailConfigured,
    isInstanceAdmin,
  }: {
    email: string;
    mailConfigured: boolean;
    isInstanceAdmin: boolean;
  } = $props();

  let isSending = $state(false);

  async function resendVerificationEmail() {
    isSending = true;
    const { error } = await sendVerificationEmail({ email, callbackURL: "/organizations/" });
    isSending = false;
    if (error) {
      toastState.add(error.message ?? "Failed to send verification email", "error");
      return;
    }
    toastState.add(`Verification email sent to ${email}`, "success");
  }
</script>

<Alert.Root class="mb-6 compact:mb-3">
  <MailWarning />
  <Alert.Title>Your email address {email} is not verified</Alert.Title>
  <Alert.Description>
    <p>Until it is verified:</p>
    <ul class="list-disc pl-5">
      <li>Invitations sent to this address are not listed on this page.</li>
      {#if mailConfigured}
        <li>You cannot accept or decline invitations.</li>
      {/if}
      <li>You cannot link a single sign-on provider or another sign-in method to this account.</li>
    </ul>
    {#if isInstanceAdmin}
      <p>
        As an instance administrator, you can mark it as verified under
        <a class="underline" href="/instance-settings/users/">Instance settings, Users</a>.
      </p>
    {:else}
      <p>An instance administrator can mark it as verified under Instance settings, Users.</p>
    {/if}
    {#if mailConfigured}
      <p>You can also use the link in your verification email, or request a new one.</p>
      <Button variant="outline" size="sm" class="mt-2" onclick={resendVerificationEmail} disabled={isSending}>
        Resend verification email
      </Button>
    {/if}
  </Alert.Description>
</Alert.Root>
