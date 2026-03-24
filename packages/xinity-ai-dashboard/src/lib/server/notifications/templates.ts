/**
 * Maps notification event types to their email templates and subject line generators.
 */
import type { Component } from "svelte";
import { NotificationType } from "./events";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- template props vary per notification type
type AnyComponent = Component<any>;

import EmailWelcomeTemplate from "$lib/components/mailTemplates/EmailWelcomeTemplate.svelte";
import EmailDeploymentReadyTemplate from "$lib/components/mailTemplates/EmailDeploymentReadyTemplate.svelte";
import EmailDeploymentFailedTemplate from "$lib/components/mailTemplates/EmailDeploymentFailedTemplate.svelte";
import EmailDeploymentCreatedTemplate from "$lib/components/mailTemplates/EmailDeploymentCreatedTemplate.svelte";
import EmailNodeStatusTemplate from "$lib/components/mailTemplates/EmailNodeStatusTemplate.svelte";
import EmailCapacityWarningTemplate from "$lib/components/mailTemplates/EmailCapacityWarningTemplate.svelte";
import EmailWeeklyReportTemplate from "$lib/components/mailTemplates/EmailWeeklyReportTemplate.svelte";
import EmailMemberEventTemplate from "$lib/components/mailTemplates/EmailMemberEventTemplate.svelte";
import EmailNotificationTemplate from "$lib/components/mailTemplates/EmailNotificationTemplate.svelte";

const templateMap: Record<NotificationType, AnyComponent> = {
  welcome: EmailWelcomeTemplate,
  deployment_ready: EmailDeploymentReadyTemplate,
  deployment_failed: EmailDeploymentFailedTemplate,
  deployment_created: EmailDeploymentCreatedTemplate,
  node_offline: EmailNodeStatusTemplate,
  node_online: EmailNodeStatusTemplate,
  capacity_warning: EmailCapacityWarningTemplate,
  weekly_report: EmailWeeklyReportTemplate,
  member_joined: EmailMemberEventTemplate,
  member_role_changed: EmailMemberEventTemplate,
  member_removed: EmailMemberEventTemplate,
};

export function getTemplateForType(type: NotificationType): AnyComponent {
  return templateMap[type] ?? EmailNotificationTemplate;
}

type SubjectGenerator = (data: Record<string, unknown>) => string;

const subjectMap: Record<NotificationType, SubjectGenerator> = {
  welcome: () => "Welcome to Xinity!",
  deployment_ready: (d) => `Deployment "${d.deploymentName}" is ready`,
  deployment_failed: (d) => `Deployment "${d.deploymentName}" has failed`,
  deployment_created: (d) => `New deployment "${d.deploymentName}" created`,
  node_offline: (d) => `Node ${d.nodeHost} went offline`,
  node_online: (d) => `Node ${d.nodeHost} is back online`,
  capacity_warning: (d) => `Capacity warning: ${d.usedPercent}% utilization`,
  weekly_report: (d) => `Weekly Report: ${d.orgName}`,
  member_joined: (d) => `${d.memberName} joined ${d.orgName}`,
  member_role_changed: (d) => `${d.memberName}'s role changed in ${d.orgName}`,
  member_removed: (d) => `${d.memberName} was removed from ${d.orgName}`,
};

export function getSubjectForType(type: NotificationType, data: Record<string, unknown>): string {
  const generator = subjectMap[type];
  return generator ? generator(data) : "Notification from Xinity";
}
