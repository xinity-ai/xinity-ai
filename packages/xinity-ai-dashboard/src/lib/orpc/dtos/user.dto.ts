/**
 * DTO schema for user profiles and settings.
 */
import { z } from "zod";
import { CommonDto } from "./common.dto";

export const UserDto = CommonDto.extend({
  id: z.string(),
  name: z.string().describe("Given name of the user, for ease of recognition. This is a self modifiable setting."),
  image: z.url().nullable().optional().describe("Optional image url to associate with the user"),
  notificationSettings: z.object({
    emailNotifications: z.boolean().default(false).describe("Setting to enable email notifications alltogether, other then critical ones"),
    modelTrainingAlerts: z.boolean().default(false).describe("If set, you will be informed about state changes in training jobs"),
    weeklyReports: z.boolean().default(false).describe("If set you will receive weekly reports about model usage and data changes"),
    apiUsageAlerts: z.boolean().default(false),
  }),
  displaySettings: z.object({
    darkMode: z.boolean().default(false),
    compactView: z.boolean().default(false).describe("Enables compact view, leaving less empty space on the page"),
    showDetailedMetrics: z.boolean().default(false),
    gettingStartedDismissed: z.boolean().default(false),
  }),
});
