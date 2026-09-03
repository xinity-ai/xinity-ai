import type { Component } from "svelte";
import { render } from 'svelte/server';
import mjml from "mjml";
import nodemailer from "nodemailer";
import { config } from "./config";
import { rootLogger } from "./logging";

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
  preferencesUrl: `${config.server.origin}/settings/notifications/`,
};

export async function renderEmailTemplate<Props extends Record<string, unknown>>(
  EmailComponent: AnyComponent,
  props: Props
) {
  const e = render(EmailComponent, {
    props,
  });

  return await mjml(e.body, {
    keepComments: false,
  });
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
    const { html, errors } = await renderEmailTemplate(template, props);

    if (errors.length > 0) {
      log.warn({ errors }, "MJML rendering produced errors");
    }

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
