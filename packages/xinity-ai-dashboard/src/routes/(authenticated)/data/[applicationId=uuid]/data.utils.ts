import type { ApiCallInputMessageContent } from "common-db";

/**
 * Normalizes message content that may be a plain string or an array of
 * structured content parts into a single string.  Non-text parts are
 * silently skipped.
 */
export function messageContentToString(
  content: string | ApiCallInputMessageContent[] | null | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
}

/**
 * Convert a xinity-media:// or other image_url URL into an <img> src
 * that the browser can fetch. xinity-media:// URLs are routed through
 * the authenticated /data/media/[sha256] endpoint.
 */
export function resolveImageSrc(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol === "xinity-media:") {
    return `/data/media/${parsed.hostname}`;
  }
  return url;
}

export interface RoleStyle {
  borderColor: string;
  bgColor: string;
  badgeColor: string;
  label: string;
}

const roleStyles: Record<string, RoleStyle> = {
  user: {
    borderColor: "border-l-xinity-purple",
    bgColor: "bg-blue-50/50 dark:bg-blue-950/20",
    badgeColor: "bg-xinity-magenta/15 text-xinity-pink dark:bg-xinity-magenta/20 dark:text-xinity-pink",
    label: "User",
  },
  system: {
    borderColor: "border-l-amber-500",
    bgColor: "bg-amber-50/50 dark:bg-amber-950/20",
    badgeColor: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
    label: "System",
  },
  assistant: {
    borderColor: "border-l-green-500",
    bgColor: "bg-green-50/50 dark:bg-green-950/20",
    badgeColor: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
    label: "Assistant",
  },
  tool: {
    borderColor: "border-l-purple-500",
    bgColor: "bg-purple-50/50 dark:bg-purple-950/20",
    badgeColor: "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300",
    label: "Tool",
  },
};

const defaultRoleStyle: RoleStyle = {
  borderColor: "border-l-gray-400",
  bgColor: "bg-muted/30",
  badgeColor: "bg-gray-100 text-gray-600",
  label: "Unknown",
};

export function getRoleStyle(role: string): RoleStyle {
  return roleStyles[role] ?? defaultRoleStyle;
}
