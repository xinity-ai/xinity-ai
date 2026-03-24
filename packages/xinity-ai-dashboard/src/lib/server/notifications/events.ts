/**
 * Notification event type definitions and their mapping to user preference toggles.
 */
import type { NotificationSettings } from "common-db";

export const NotificationType = {
  // Account (always sent)
  welcome: "welcome",

  // Deployment lifecycle (modelTrainingAlerts)
  deployment_ready: "deployment_ready",
  deployment_failed: "deployment_failed",
  deployment_created: "deployment_created",

  // System health (apiUsageAlerts)
  node_offline: "node_offline",
  node_online: "node_online",
  capacity_warning: "capacity_warning",

  // Periodic (weeklyReports)
  weekly_report: "weekly_report",

  // Organization events (emailNotifications)
  member_joined: "member_joined",
  member_role_changed: "member_role_changed",
  member_removed: "member_removed",
} as const;

export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

/**
 * Maps each notification type to the user preference key that controls it.
 * `null` means the notification is always sent (cannot be disabled).
 */
export const notificationSettingsKey: Record<NotificationType, keyof NotificationSettings | null> = {
  welcome: null,

  deployment_ready: "modelTrainingAlerts",
  deployment_failed: "modelTrainingAlerts",
  deployment_created: "modelTrainingAlerts",

  node_offline: "apiUsageAlerts",
  node_online: "apiUsageAlerts",
  capacity_warning: "apiUsageAlerts",

  weekly_report: "weeklyReports",

  member_joined: "emailNotifications",
  member_role_changed: "emailNotifications",
  member_removed: "emailNotifications",
};

/**
 * Check whether a user has opted in to a particular notification type.
 * Returns true for "always sent" types (settingsKey === null).
 */
export function isNotificationEnabled(
  settings: NotificationSettings,
  type: NotificationType,
): boolean {
  // Master toggle: blocks everything except always-sent types
  if (!settings.emailNotifications && notificationSettingsKey[type] !== null) {
    return false;
  }

  const key = notificationSettingsKey[type];
  if (key === null) return true;
  return settings[key];
}
