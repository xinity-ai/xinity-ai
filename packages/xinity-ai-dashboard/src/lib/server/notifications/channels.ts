/**
 * Notification channel abstraction.
 * Currently only email is implemented; Slack, Teams, Telegram can be added
 * by implementing the NotificationChannel interface.
 */
import type { Component } from "svelte";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- template props vary per notification type
type AnyComponent = Component<any>;
import { sendEmail } from "$lib/server/email";
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
export const emailChannel: NotificationChannel = {
  name: "email",

  async send({ recipient, subject, template, props }) {
    await sendEmail({
      to: recipient.email,
      subject,
      template,
      props,
    });
    log.debug({ to: recipient.email, subject }, "Notification email dispatched");
  },
};

/** Active channels. Add new channel implementations here. */
export const activeChannels: NotificationChannel[] = [emailChannel];
