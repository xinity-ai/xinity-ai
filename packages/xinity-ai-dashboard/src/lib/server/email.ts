import type { Component } from "svelte";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- template props vary per call site
type AnyComponent = Component<any>;
import { render } from 'svelte/server';
import mjml from "mjml";
import nodemailer from "nodemailer";
import { serverEnv } from "./serverenv";
import { rootLogger } from "./logging";

const log = rootLogger.child({ name: "email" });

const transporter = serverEnv.MAIL_URL
  ? nodemailer.createTransport(serverEnv.MAIL_URL)
  : null;

export async function renderEmailTemplate<Props extends Record<string, unknown>>(
  EmailComponent: AnyComponent,
  props: Props
) {
  const e = render(EmailComponent, {
    props,
  });

  return mjml(e.body, {
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
  try {
    const { html, errors } = await renderEmailTemplate(template, props);

    if (errors.length > 0) {
      log.warn({ errors }, "MJML rendering produced errors");
    }

    if (transporter && serverEnv.MAIL_FROM) {
      const info = await transporter.sendMail({
        from: serverEnv.MAIL_FROM,
        to,
        subject,
        html,
      });
      log.info({ messageId: info.messageId, to, subject }, "Email sent successfully");
      return;
    } else {
      log.warn({ to, subject, props }, "Email not sent: No transporter or from address");
      return;
    }

  } catch (error) {
    log.error({ err: error }, "Failed to send email");
    throw error;
  }
}
