import type { Component } from "svelte";
import { render } from 'svelte/server';
import nodemailer from "nodemailer";
import { config } from "$lib/server/config";
import { rootLogger } from "$lib/server/logging";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- template props vary per call site
export type AnyComponent = Component<any>;

const log = rootLogger.child({ name: "email" });

const mailer = config.mail && {
  transport: nodemailer.createTransport(config.mail.url),
  from: config.mail.from,
};

/** Props every email template expects (appName, preferences link). Merge into per-template props. */
export const commonEmailProps = {
  appName: config.appName,
  preferencesUrl: `${config.origin}/settings/notifications/`,
};

export function renderEmailTemplate<Props extends Record<string, unknown>>(
  EmailComponent: AnyComponent,
  props: Props
) {
  const { head, body } = render(EmailComponent, { props });
  const html = `<!doctype html><html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body style="margin:0;padding:0">${body}</body></html>`;
  // Svelte's hydration markers are dead weight in a mail client, but Outlook's conditional comments must survive.
  return html.replace(/<!--(?!\[if )[\s\S]*?-->/g, "");
}

export async function sendEmail<Props extends Record<string, unknown>>({
  to,
  subject,
  template,
  props,
}: {
  to: string;
  subject: string;
  template: AnyComponent;
  props: Props;
}) {
  if (!mailer) {
    log.warn({ to, subject, props }, "Email not sent: outbound mail is not configured");
    return;
  }

  try {
    const html = renderEmailTemplate(template, props);
    const info = await mailer.transport.sendMail({
      from: mailer.from,
      to,
      subject,
      html,
    });
    log.info({ messageId: info.messageId, to, subject }, "Email sent successfully");
  } catch (error) {
    log.error({ err: error }, "Failed to send email");
    throw error;
  }
}
