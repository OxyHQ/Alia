/**
 * Integration Tools — backward-compatible re-export
 *
 * All integration logic has been split into per-service modules:
 *   integrations/shared.ts       — validators, safeExecute, authedFetch
 *   integrations/github.ts       — GitHub tools
 *   integrations/notion.ts       — Notion tools
 *   integrations/google-calendar.ts — Google Calendar tools
 *   integrations/linear.ts       — Linear tools
 *   integrations/google-drive.ts — Google Drive tools
 *   integrations/index.ts        — buildIntegrationTools() entry + cache
 */

export {
  buildIntegrationTools,
  buildGitHubTools,
  buildNotionTools,
  buildGoogleCalendarTools,
  buildLinearTools,
  buildGoogleDriveTools,
} from './integrations/index.js';
