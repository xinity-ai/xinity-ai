import type { Component } from "svelte";
import { render } from 'svelte/server';
import mjml from "mjml";
import nodemailer from "nodemailer";
import { serverEnv } from "./serverenv";
import { rootLogger } from "./logging";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- template props vary per call site
export type AnyComponent = Component<any>;

const log = rootLogger.child({ name: "email" });

const transporter = serverEnv.MAIL_URL
  ? nodemailer.createTransport(serverEnv.MAIL_URL)
  : null;

/** Props every email template expects (appName, preferences link). Merge into per-template props. */
export const commonEmailProps = {
  appName: serverEnv.APP_NAME,
  preferencesUrl: `${serverEnv.ORIGIN}/settings/notifications/`,
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
  if (!transporter || !serverEnv.MAIL_FROM) {
    log.warn({ to, subject, props }, "Email not sent: No transporter or from address");
    return;
  }

  try {
    const { html, errors } = await renderEmailTemplate(template, props);

    if (errors.length > 0) {
      log.warn({ errors }, "MJML rendering produced errors");
    }

    const info = await transporter.sendMail({
      from: serverEnv.MAIL_FROM,
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
