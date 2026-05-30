/**
 * Notification channel abstraction.
 * Currently only email is implemented; Slack, Teams, Telegram can be added
 * by implementing the NotificationChannel interface.
 */
import { sendEmail, type AnyComponent } from "$lib/server/email";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "notification.channel" });

export interface NotificationChannel {
  readonly name: string;
  send(params: {
    recipient: { email: string; name: string };
    subject: string;
    template: AnyComponent;
    props: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Email channel: delegates to the existing sendEmail() utility.
 */
function formatEmailRecipient(recipient: { email: string; name: string }): string {
  return recipient.name
    ? `${JSON.stringify(recipient.name)} <${recipient.email}>`
    : recipient.email;
}

export const emailChannel: NotificationChannel = {
  name: "email",

  async send({ recipient, subject, template, props }) {
    const to = formatEmailRecipient(recipient);
    await sendEmail({
      to,
      subject,
      template,
      props,
    });
    log.debug({ to, subject }, "Notification email dispatched");
  },
};

/** Active channels. Add new channel implementations here. */
export const activeChannels: NotificationChannel[] = [emailChannel];
