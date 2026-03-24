/**
 * Core notification service.
 * Handles preference checking, channel dispatch, and DB logging.
 */
import { userT, memberT, notificationT, sql } from "common-db";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { type NotificationType, isNotificationEnabled } from "./events";
import { emailChannel } from "./channels";
import { getTemplateForType, getSubjectForType } from "./templates";

const log = rootLogger.child({ name: "notification.service" });

export interface NotifyParams {
  type: NotificationType;
  userId: string;
  organizationId?: string;
  data: Record<string, any>;
}

/**
 * Send a notification to a single user, respecting their preferences.
 * Fire-and-forget safe; catches and logs errors internally.
 */
export async function notify(params: NotifyParams): Promise<void> {
  const { type, userId, organizationId, data } = params;

  try {
    const [user] = await getDB()
      .select({ email: userT.email, name: userT.name, notificationSettings: userT.notificationSettings })
      .from(userT)
      .where(sql`${userT.id} = ${userId}`)
      .limit(1);

    if (!user) {
      log.warn({ userId, type }, "Notification skipped: user not found");
      return;
    }

    if (!isNotificationEnabled(user.notificationSettings, type)) {
      log.debug({ userId, type }, "Notification skipped: user preference disabled");
      return;
    }

    const template = getTemplateForType(type);
    const subject = getSubjectForType(type, data);

    await emailChannel.send({
      recipient: { email: user.email, name: user.name },
      subject,
      template,
      props: data,
    });

    // Log to DB
    await getDB().insert(notificationT).values({
      userId,
      organizationId: organizationId ?? null,
      type,
      channel: emailChannel.name,
      subject,
      metadata: data,
    });

    log.info({ userId, type, channel: "email" }, "Notification sent");
  } catch (err) {
    log.error({ err, userId, type }, "Failed to send notification");
  }
}

/**
 * Send a notification to all members of an organization.
 * Each member's individual preferences are respected.
 */
export async function notifyOrgMembers(params: {
  type: NotificationType;
  organizationId: string;
  data: Record<string, any>;
  excludeUserId?: string;
}): Promise<void> {
  const { type, organizationId, data, excludeUserId } = params;

  try {
    const members = await getDB()
      .select({ userId: memberT.userId })
      .from(memberT)
      .where(sql`${memberT.organizationId} = ${organizationId}`);

    const tasks = members
      .filter(m => m.userId !== excludeUserId)
      .map(m => notify({ type, userId: m.userId, organizationId, data }));

    await Promise.allSettled(tasks);
  } catch (err) {
    log.error({ err, organizationId, type }, "Failed to notify org members");
  }
}
