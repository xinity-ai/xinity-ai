# Notifications

The dashboard sends email notifications for deployment lifecycle events, system health changes, and organizational activity. Notifications require an SMTP server (`MAIL_URL` and `MAIL_FROM` environment variables).

## Events

| Event | Subject | Trigger |
|---|---|---|
| `welcome` | Welcome to Xinity! | User signup (always sent) |
| `deployment_ready` | Deployment "{name}" is ready | Model deployment reaches ready state |
| `deployment_failed` | Deployment "{name}" has failed | Model deployment fails |
| `deployment_created` | New deployment "{name}" created | New deployment is created |
| `node_offline` | Node {host} went offline | Compute node becomes unavailable |
| `node_online` | Node {host} is back online | Compute node comes back online |
| `capacity_warning` | Capacity warning: {X}% utilization | VRAM utilization exceeds 80% |
| `weekly_report` | Weekly Report: {orgName} | Monday 8:00 AM UTC |
| `member_joined` | {name} joined {org} | User joins an organization |
| `member_role_changed` | {name}'s role changed in {org} | User's role is updated |
| `member_removed` | {name} was removed from {org} | User is removed from an organization |

The weekly report includes deployment count, active nodes, total API calls, and the top 5 models by usage.

## User Preferences

Each user controls four notification categories in Settings > Notifications:

| Toggle | Controls |
|---|---|
| **Email Notifications** | Organization events (member joined, role changed, member removed) |
| **Model Training Alerts** | Deployment lifecycle events (ready, failed, created) |
| **Weekly Reports** | Weekly usage summaries |
| **API Usage Alerts** | System health events (node offline/online, capacity warning) |

The welcome email is always sent regardless of preferences.

## Scheduling

The notification scheduler runs two check loops:

- **Every 5 minutes:** Checks deployment status changes, node health changes, and capacity thresholds.
- **Every hour:** Checks whether the weekly report is due (Monday 8 AM UTC).

On startup, the scheduler takes a snapshot of current state without sending notifications to avoid a flood of stale alerts.

The capacity warning fires when VRAM utilization crosses 80% and resets when it drops back below.

## Channels

Currently only email is implemented (via nodemailer). The notification system is designed with a channel abstraction for future extension to Slack, Teams, or other integrations.

Each notification is logged in the database for audit purposes.
