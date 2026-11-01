import { describe, test, expect } from "bun:test";
import EmailEmailChangeConfirmationTemplate from "$lib/components/mailTemplates/EmailEmailChangeConfirmationTemplate.svelte";
import EmailForgotPasswordTemplate from "$lib/components/mailTemplates/EmailForgotPasswordTemplate.svelte";
import EmailInvitationTemplate from "$lib/components/mailTemplates/EmailInvitationTemplate.svelte";
import EmailVerificationTemplate from "$lib/components/mailTemplates/EmailVerificationTemplate.svelte";
import { NotificationType } from "./events";
import { getTemplateForType } from "./templates";

const { renderEmailTemplate, commonEmailProps } = await import("./email");

const templates = [
  ...Object.values(NotificationType).map((type) => ({ name: type, template: getTemplateForType(type) })),
  { name: "email change confirmation", template: EmailEmailChangeConfirmationTemplate },
  { name: "forgot password", template: EmailForgotPasswordTemplate },
  { name: "invitation", template: EmailInvitationTemplate },
  { name: "verification", template: EmailVerificationTemplate },
];

describe("renderEmailTemplate", () => {
  for (const { name, template } of templates) {
    test(`${name} renders a complete email document`, () => {
      const html = renderEmailTemplate(template, { ...commonEmailProps, orgName: "Acme" });

      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain("<title>");
      expect(html).toContain("<!--[if mso]>");
      expect(html.match(/<!--(?!\[if )/)).toBeNull();
      expect(html.match(/<div[^>]*padding/)).toBeNull();
    });
  }
});
