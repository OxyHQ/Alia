/**
 * Integration Tools — Dynamic tools from user's connected OAuth integrations
 *
 * Queries the user's active Integration documents and creates AI SDK tool()
 * wrappers so the AI can interact with GitHub, Notion, Google Calendar,
 * Linear, and Google Drive on the user's behalf.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Integration } from '../../models/integration.js';
import { getValidToken } from '../integration-token.js';
import { log } from '../logger.js';

const TOOL_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Input validators — prevent path traversal, injection via AI-controlled params
// ---------------------------------------------------------------------------

/** GitHub "owner/repo" — alphanumeric, hyphens, underscores, dots, one slash */
const GITHUB_REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/** Notion/Linear IDs — UUID v4 with or without dashes */
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Google Drive file IDs — alphanumeric, hyphens, underscores */
const DRIVE_FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function assertGitHubRepo(repo: string): void {
  if (!GITHUB_REPO_RE.test(repo)) {
    throw new Error('Invalid repository format — expected "owner/repo"');
  }
}

function assertUUID(id: string, label: string): void {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid ${label} — expected a UUID`);
  }
}

function assertDriveFileId(id: string): void {
  if (!DRIVE_FILE_ID_RE.test(id)) {
    throw new Error('Invalid Drive file ID');
  }
}

// Short-lived cache (same pattern as MCP tools)
const cache = new Map<string, { tools: ToolSet; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

/**
 * Build integration tools for a user based on their connected OAuth services.
 */
export async function buildIntegrationTools(oxyUserId: string): Promise<ToolSet> {
  if (!mongoose.Types.ObjectId.isValid(oxyUserId)) return {};

  const cached = cache.get(oxyUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;

  const tools: ToolSet = {};

  try {
    const integrations = await Integration.find({
      oxyUserId: new mongoose.Types.ObjectId(oxyUserId),
      enabled: true,
      status: 'active',
    })
      .select('service')
      .lean();

    const connectedServices = new Set(integrations.map(i => i.service));

    if (connectedServices.has('github')) {
      Object.assign(tools, buildGitHubTools(oxyUserId));
    }
    if (connectedServices.has('notion')) {
      Object.assign(tools, buildNotionTools(oxyUserId));
    }
    if (connectedServices.has('google-calendar')) {
      Object.assign(tools, buildGoogleCalendarTools(oxyUserId));
    }
    if (connectedServices.has('linear')) {
      Object.assign(tools, buildLinearTools(oxyUserId));
    }
    if (connectedServices.has('google-drive')) {
      Object.assign(tools, buildGoogleDriveTools(oxyUserId));
    }

    cache.set(oxyUserId, { tools, expiresAt: Date.now() + CACHE_TTL_MS });

    const toolCount = Object.keys(tools).length;
    if (toolCount > 0) {
      log.general.info({ userId: oxyUserId, toolCount }, 'Integration tools loaded');
    }

    return tools;
  } catch (err) {
    log.general.error({ err, userId: oxyUserId }, 'Failed to load integration tools');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Helper: authenticated fetch with token refresh
// ---------------------------------------------------------------------------

async function authedFetch(
  userId: string,
  service: string,
  url: string,
  options: RequestInit = {},
): Promise<any> {
  const token = await getValidToken(userId, service);
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${service} API error (${response.status}): ${body.slice(0, 200)}`);
  }

  // Update lastUsedAt in background
  Integration.updateOne(
    { oxyUserId: new mongoose.Types.ObjectId(userId), service, enabled: true },
    { lastUsedAt: new Date() },
  ).catch(() => {});

  return response.json();
}

// ---------------------------------------------------------------------------
// GitHub tools
// ---------------------------------------------------------------------------

function buildGitHubTools(userId: string): ToolSet {
  return {
    searchGitHubRepos: tool({
      description: '[GitHub] Search repositories. Use when user asks about their repos or wants to find a repository.',
      parameters: z.object({
        query: z.string().describe('Search query (e.g. repo name, topic, language)'),
      }),
      execute: async ({ query }) => {
        const data = await authedFetch(userId, 'github', `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=10`, {
          headers: { Accept: 'application/vnd.github.v3+json' },
        });
        return data.items.map((r: any) => ({
          name: r.full_name,
          description: r.description,
          language: r.language,
          stars: r.stargazers_count,
          url: r.html_url,
          updated: r.updated_at,
        }));
      },
    }),

    getGitHubIssues: tool({
      description: '[GitHub] List issues for a repository. Use when user asks about issues in a specific repo.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format'),
        state: z.enum(['open', 'closed', 'all']).default('open').describe('Issue state filter'),
      }),
      execute: async ({ repo, state }) => {
        assertGitHubRepo(repo);
        const data = await authedFetch(userId, 'github', `https://api.github.com/repos/${encodeURIComponent(repo)}/issues?state=${state}&per_page=15`, {
          headers: { Accept: 'application/vnd.github.v3+json' },
        });
        return data.map((i: any) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          author: i.user?.login,
          labels: i.labels?.map((l: any) => l.name),
          created: i.created_at,
          url: i.html_url,
        }));
      },
    }),

    getGitHubPullRequests: tool({
      description: '[GitHub] List pull requests for a repository. Use when user asks about PRs.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format'),
        state: z.enum(['open', 'closed', 'all']).default('open').describe('PR state filter'),
      }),
      execute: async ({ repo, state }) => {
        assertGitHubRepo(repo);
        const data = await authedFetch(userId, 'github', `https://api.github.com/repos/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=15`, {
          headers: { Accept: 'application/vnd.github.v3+json' },
        });
        return data.map((pr: any) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.user?.login,
          created: pr.created_at,
          url: pr.html_url,
          draft: pr.draft,
        }));
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Notion tools
// ---------------------------------------------------------------------------

function buildNotionTools(userId: string): ToolSet {
  const notionHeaders = { 'Notion-Version': '2022-06-28' };

  return {
    searchNotionPages: tool({
      description: '[Notion] Search pages and databases in the user\'s workspace.',
      parameters: z.object({
        query: z.string().describe('Search query'),
      }),
      execute: async ({ query }) => {
        const data = await authedFetch(userId, 'notion', 'https://api.notion.com/v1/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...notionHeaders },
          body: JSON.stringify({ query, page_size: 10 }),
        });
        return data.results.map((r: any) => ({
          id: r.id,
          type: r.object,
          title: r.properties?.title?.title?.[0]?.plain_text
            || r.properties?.Name?.title?.[0]?.plain_text
            || r.title?.[0]?.plain_text
            || 'Untitled',
          url: r.url,
          lastEdited: r.last_edited_time,
        }));
      },
    }),

    getNotionPage: tool({
      description: '[Notion] Get the content of a specific Notion page by ID.',
      parameters: z.object({
        pageId: z.string().describe('The Notion page ID'),
      }),
      execute: async ({ pageId }) => {
        assertUUID(pageId, 'Notion page ID');
        const [page, blocks] = await Promise.all([
          authedFetch(userId, 'notion', `https://api.notion.com/v1/pages/${pageId}`, {
            headers: notionHeaders,
          }),
          authedFetch(userId, 'notion', `https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, {
            headers: notionHeaders,
          }),
        ]);

        // Extract text content from blocks
        const content = blocks.results.map((block: any) => {
          const type = block.type;
          const richText = block[type]?.rich_text || block[type]?.text;
          if (Array.isArray(richText)) {
            return richText.map((t: any) => t.plain_text).join('');
          }
          return '';
        }).filter(Boolean).join('\n');

        return {
          id: page.id,
          url: page.url,
          lastEdited: page.last_edited_time,
          content: content.slice(0, 3000),
        };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Google Calendar tools
// ---------------------------------------------------------------------------

function buildGoogleCalendarTools(userId: string): ToolSet {
  return {
    listCalendarEvents: tool({
      description: '[Google Calendar] List upcoming calendar events. Use when user asks about their schedule, meetings, or appointments.',
      parameters: z.object({
        timeMin: z.string().optional().describe('Start time in ISO 8601 format (defaults to now)'),
        timeMax: z.string().optional().describe('End time in ISO 8601 format (defaults to 7 days from now)'),
      }),
      execute: async ({ timeMin, timeMax }) => {
        const now = new Date();
        const min = timeMin || now.toISOString();
        const max = timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const params = new URLSearchParams({
          timeMin: min,
          timeMax: max,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '20',
        });
        const data = await authedFetch(userId, 'google-calendar', `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
        return (data.items || []).map((e: any) => ({
          id: e.id,
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          location: e.location,
          description: e.description?.slice(0, 200),
          attendees: e.attendees?.map((a: any) => a.email),
          htmlLink: e.htmlLink,
        }));
      },
    }),

    createCalendarEvent: tool({
      description: '[Google Calendar] Create a new calendar event. Use when user wants to schedule something.',
      parameters: z.object({
        summary: z.string().describe('Event title'),
        start: z.string().describe('Start time in ISO 8601 format'),
        end: z.string().describe('End time in ISO 8601 format'),
        description: z.string().optional().describe('Event description'),
        location: z.string().optional().describe('Event location'),
      }),
      execute: async ({ summary, start, end, description, location }) => {
        const event: any = {
          summary,
          start: { dateTime: start },
          end: { dateTime: end },
        };
        if (description) event.description = description;
        if (location) event.location = location;

        const data = await authedFetch(userId, 'google-calendar', 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
        return {
          id: data.id,
          summary: data.summary,
          start: data.start?.dateTime || data.start?.date,
          end: data.end?.dateTime || data.end?.date,
          htmlLink: data.htmlLink,
        };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Linear tools
// ---------------------------------------------------------------------------

function buildLinearTools(userId: string): ToolSet {
  async function linearGraphQL(userId: string, query: string, variables?: Record<string, any>) {
    return authedFetch(userId, 'linear', 'https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  }

  return {
    searchLinearIssues: tool({
      description: '[Linear] Search issues in the user\'s Linear workspace.',
      parameters: z.object({
        query: z.string().describe('Search query for issues'),
      }),
      execute: async ({ query }) => {
        const data = await linearGraphQL(userId, `
          query SearchIssues($query: String!) {
            issueSearch(query: $query, first: 15) {
              nodes {
                id identifier title state { name } priority assignee { name }
                createdAt url
              }
            }
          }
        `, { query });
        return (data.data?.issueSearch?.nodes || []).map((i: any) => ({
          id: i.identifier,
          title: i.title,
          state: i.state?.name,
          priority: i.priority,
          assignee: i.assignee?.name,
          created: i.createdAt,
          url: i.url,
        }));
      },
    }),

    createLinearIssue: tool({
      description: '[Linear] Create a new issue in the user\'s Linear workspace.',
      parameters: z.object({
        title: z.string().describe('Issue title'),
        description: z.string().optional().describe('Issue description (markdown)'),
        teamId: z.string().optional().describe('Team ID (uses first team if not specified)'),
      }),
      execute: async ({ title, description, teamId }) => {
        if (teamId) assertUUID(teamId, 'Linear team ID');
        // If no team specified, get the first team
        let resolvedTeamId = teamId;
        if (!resolvedTeamId) {
          const teamsData = await linearGraphQL(userId, '{ teams(first: 1) { nodes { id name } } }');
          resolvedTeamId = teamsData.data?.teams?.nodes?.[0]?.id;
          if (!resolvedTeamId) {
            return { error: 'No teams found in Linear workspace' };
          }
        }

        const data = await linearGraphQL(userId, `
          mutation CreateIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue { id identifier title url state { name } }
            }
          }
        `, {
          input: { title, description, teamId: resolvedTeamId },
        });

        const issue = data.data?.issueCreate?.issue;
        if (!issue) {
          return { error: 'Failed to create issue' };
        }
        return {
          id: issue.identifier,
          title: issue.title,
          state: issue.state?.name,
          url: issue.url,
        };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Google Drive tools
// ---------------------------------------------------------------------------

function buildGoogleDriveTools(userId: string): ToolSet {
  return {
    searchDriveFiles: tool({
      description: '[Google Drive] Search files in the user\'s Google Drive.',
      parameters: z.object({
        query: z.string().describe('Search query (file name, content keywords)'),
      }),
      execute: async ({ query }) => {
        // Escape backslashes first, then single quotes (Drive API query syntax)
        const safeQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const params = new URLSearchParams({
          q: `fullText contains '${safeQuery}'`,
          pageSize: '15',
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)',
        });
        const data = await authedFetch(userId, 'google-drive', `https://www.googleapis.com/drive/v3/files?${params}`);
        return (data.files || []).map((f: any) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          modified: f.modifiedTime,
          url: f.webViewLink,
          size: f.size,
        }));
      },
    }),

    getDriveFileContent: tool({
      description: '[Google Drive] Get the text content of a file from Google Drive (works for Google Docs, Sheets, and text files).',
      parameters: z.object({
        fileId: z.string().describe('The Drive file ID'),
      }),
      execute: async ({ fileId }) => {
        assertDriveFileId(fileId);
        // First get file metadata to determine type
        const meta = await authedFetch(userId, 'google-drive', `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`);

        // For Google Docs, export as plain text
        if (meta.mimeType === 'application/vnd.google-apps.document') {
          const token = await getValidToken(userId, 'google-drive');
          const response = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
            },
          );
          const text = await response.text();
          return { name: meta.name, mimeType: meta.mimeType, content: text.slice(0, 5000) };
        }

        // For Google Sheets, export as CSV
        if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
          const token = await getValidToken(userId, 'google-drive');
          const response = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
            },
          );
          const text = await response.text();
          return { name: meta.name, mimeType: meta.mimeType, content: text.slice(0, 5000) };
        }

        // For regular text files, download content
        const token = await getValidToken(userId, 'google-drive');
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
          },
        );
        const text = await response.text();
        return { name: meta.name, mimeType: meta.mimeType, content: text.slice(0, 5000) };
      },
    }),
  };
}
