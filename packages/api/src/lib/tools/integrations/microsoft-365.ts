/**
 * Microsoft 365 through Microsoft Graph: Outlook (mail and calendar), Teams
 * (chats and channels) and SharePoint/OneDrive files.
 *
 * Each is its own connection with its own least set of delegated scopes
 * (`lib/integration-registry.ts`), so a person who connects Outlook has granted
 * nothing in Teams. Graph enforces the signed-in person's own permissions on
 * every call; these tools only shape requests and answers.
 *
 * Arguments that carry free text are named `search` rather than `query`: the
 * runtime policy scans a `query` argument for shell and SQL commands, and a mail
 * search for "server shutdown" is not one.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { pdfText } from '../../files/pdf-text.js';
import { authedFetch, authedFetchBytes, safeExecute } from './shared.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_TEXT_CHARS = 10_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** A Graph id goes into a path, so it is encoded and bounded rather than trusted. */
const graphId = z.string().min(1).max(512);

export function graphPath(...segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

/** KQL inside `$search="…"`: the quote that would close it is dropped. */
export function graphSearchTerm(search: string): string {
  return `"${search.replace(/["\\]/g, ' ').trim()}"`;
}

/** Teams and Outlook bodies are HTML; the model reads text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n[Truncated: only the first ${MAX_TEXT_CHARS} characters are shown.]`
    : text;
}

const recipients = (emails: readonly string[]) =>
  emails.map((address) => ({ emailAddress: { address } }));

const addressOf = (r: any): string | undefined =>
  r?.emailAddress
    ? `${r.emailAddress.name ?? ''} <${r.emailAddress.address ?? ''}>`.trim()
    : undefined;

// ---------------------------------------------------------------------------
// Outlook
// ---------------------------------------------------------------------------

export function buildOutlookTools(userId: string): ToolSet {
  const service = 'microsoft-outlook';
  const fetchGraph = (path: string, init: RequestInit = {}) =>
    authedFetch(userId, service, `${GRAPH}/${path}`, init);

  return {
    searchOutlookMail: tool({
      description:
        "[Outlook] Search the person's Outlook mail, or list the newest messages in a folder when no search is given.",
      inputSchema: z.object({
        search: z
          .string()
          .max(500)
          .optional()
          .describe('Words to search for (subject, body, people)'),
        folder: z
          .enum(['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail'])
          .optional()
          .describe('Folder to list when there is no search (default inbox)'),
        unreadOnly: z.boolean().optional().describe('Only unread messages (ignored with a search)'),
        limit: z.number().int().min(1).max(25).optional().describe('How many (default 10)'),
      }),
      execute: async ({ search, folder, unreadOnly, limit }) =>
        safeExecute('Outlook', async () => {
          const params = new URLSearchParams({
            $top: String(limit ?? 10),
            $select:
              'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,webLink',
          });
          let path: string;
          if (search?.trim()) {
            params.set('$search', graphSearchTerm(search));
            path = `me/messages?${params}`;
          } else {
            params.set('$orderby', 'receivedDateTime desc');
            if (unreadOnly) params.set('$filter', 'isRead eq false');
            path = `me/mailFolders/${graphPath(folder ?? 'inbox')}/messages?${params}`;
          }
          const data = await fetchGraph(path);
          return (data.value ?? []).map((m: any) => ({
            id: m.id,
            subject: m.subject,
            from: addressOf(m.from),
            to: (m.toRecipients ?? []).map(addressOf),
            received: m.receivedDateTime,
            preview: m.bodyPreview,
            isRead: m.isRead,
            hasAttachments: m.hasAttachments,
            url: m.webLink,
          }));
        }),
    }),

    readOutlookMail: tool({
      description: '[Outlook] Read one Outlook message in full, as text.',
      inputSchema: z.object({ messageId: graphId.describe('The message id from a search') }),
      execute: async ({ messageId }) =>
        safeExecute('Outlook', async () => {
          const params = new URLSearchParams({
            $select:
              'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,webLink,conversationId',
          });
          const m = await fetchGraph(`me/messages/${graphPath(messageId)}?${params}`, {
            headers: { Prefer: 'outlook.body-content-type="text"' },
          });
          const body = typeof m.body?.content === 'string' ? m.body.content : '';
          return {
            id: m.id,
            subject: m.subject,
            from: addressOf(m.from),
            to: (m.toRecipients ?? []).map(addressOf),
            cc: (m.ccRecipients ?? []).map(addressOf),
            received: m.receivedDateTime,
            hasAttachments: m.hasAttachments,
            url: m.webLink,
            body: clip(m.body?.contentType === 'html' ? htmlToText(body) : body),
          };
        }),
    }),

    sendOutlookMail: tool({
      description: '[Outlook] Send an email from the person’s Outlook account.',
      inputSchema: z.object({
        to: z.array(z.string().email()).min(1).max(50),
        cc: z.array(z.string().email()).max(50).optional(),
        subject: z.string().max(500),
        body: z.string().max(100_000).describe('Plain text body'),
      }),
      execute: async ({ to, cc, subject, body }) =>
        safeExecute('Outlook', async () => {
          await fetchGraph('me/sendMail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: {
                subject,
                body: { contentType: 'Text', content: body },
                toRecipients: recipients(to),
                ...(cc?.length ? { ccRecipients: recipients(cc) } : {}),
              },
              saveToSentItems: true,
            }),
          });
          return { sent: true, to, subject };
        }),
    }),

    replyToOutlookMail: tool({
      description: '[Outlook] Reply to an Outlook message (to its sender, or to everyone on it).',
      inputSchema: z.object({
        messageId: graphId,
        body: z.string().max(100_000).describe('Plain text reply'),
        replyAll: z.boolean().optional(),
      }),
      execute: async ({ messageId, body, replyAll }) =>
        safeExecute('Outlook', async () => {
          await fetchGraph(
            `me/messages/${graphPath(messageId)}/${replyAll ? 'replyAll' : 'reply'}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ comment: body }),
            },
          );
          return { sent: true, messageId, replyAll: !!replyAll };
        }),
    }),

    listOutlookEvents: tool({
      description:
        "[Outlook] List events on the person's Outlook calendar between two times (default: the next 7 days).",
      inputSchema: z.object({
        start: z.string().optional().describe('ISO 8601 start (default now)'),
        end: z.string().optional().describe('ISO 8601 end (default 7 days after start)'),
      }),
      execute: async ({ start, end }) =>
        safeExecute('Outlook', async () => {
          const from = start ? new Date(start) : new Date();
          const to = end ? new Date(end) : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
          if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
            throw new Error('start and end must be ISO 8601 times');
          }
          const params = new URLSearchParams({
            startDateTime: from.toISOString(),
            endDateTime: to.toISOString(),
            $top: '50',
            $orderby: 'start/dateTime',
            $select:
              'id,subject,start,end,location,attendees,organizer,isOnlineMeeting,onlineMeeting,webLink,bodyPreview',
          });
          const data = await fetchGraph(`me/calendarView?${params}`, {
            headers: { Prefer: 'outlook.timezone="UTC"' },
          });
          return (data.value ?? []).map((e: any) => ({
            id: e.id,
            subject: e.subject,
            start: e.start?.dateTime ? `${e.start.dateTime}Z` : undefined,
            end: e.end?.dateTime ? `${e.end.dateTime}Z` : undefined,
            location: e.location?.displayName || undefined,
            organizer: addressOf(e.organizer),
            attendees: (e.attendees ?? []).map(addressOf),
            joinUrl: e.onlineMeeting?.joinUrl,
            preview: e.bodyPreview?.slice(0, 200),
            url: e.webLink,
          }));
        }),
    }),

    createOutlookEvent: tool({
      description:
        "[Outlook] Create an event on the person's Outlook calendar, inviting attendees if given.",
      inputSchema: z.object({
        subject: z.string().max(500),
        start: z.string().describe('ISO 8601 start'),
        end: z.string().describe('ISO 8601 end'),
        timeZone: z
          .string()
          .max(64)
          .optional()
          .describe('IANA or Windows time zone for start and end without an offset (default UTC)'),
        body: z.string().max(20_000).optional(),
        location: z.string().max(500).optional(),
        attendees: z.array(z.string().email()).max(100).optional(),
        online: z.boolean().optional().describe('Add a Teams meeting link'),
      }),
      execute: async ({ subject, start, end, timeZone, body, location, attendees, online }) =>
        safeExecute('Outlook', async () => {
          const data = await fetchGraph('me/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              subject,
              start: { dateTime: start, timeZone: timeZone ?? 'UTC' },
              end: { dateTime: end, timeZone: timeZone ?? 'UTC' },
              ...(body ? { body: { contentType: 'Text', content: body } } : {}),
              ...(location ? { location: { displayName: location } } : {}),
              ...(attendees?.length
                ? {
                    attendees: attendees.map((address) => ({
                      emailAddress: { address },
                      type: 'required',
                    })),
                  }
                : {}),
              ...(online
                ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' }
                : {}),
            }),
          });
          return {
            id: data.id,
            subject: data.subject,
            start: data.start,
            end: data.end,
            joinUrl: data.onlineMeeting?.joinUrl,
            url: data.webLink,
          };
        }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export function buildTeamsTools(userId: string): ToolSet {
  const service = 'microsoft-teams';
  const fetchGraph = (path: string, init: RequestInit = {}) =>
    authedFetch(userId, service, `${GRAPH}/${path}`, init);

  const messageOf = (m: any) => ({
    id: m.id,
    from: m.from?.user?.displayName ?? m.from?.application?.displayName,
    sent: m.createdDateTime,
    text: clip(
      m.body?.contentType === 'html' ? htmlToText(m.body?.content ?? '') : (m.body?.content ?? ''),
    ),
  });

  return {
    listTeamsChats: tool({
      description:
        "[Microsoft Teams] List the person's recent Teams chats (one-on-one, group and meeting chats).",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe('How many (default 20)'),
      }),
      execute: async ({ limit }) =>
        safeExecute('Microsoft Teams', async () => {
          const params = new URLSearchParams({
            $top: String(limit ?? 20),
            $expand: 'members,lastMessagePreview',
            $orderby: 'lastMessagePreview/createdDateTime desc',
          });
          const data = await fetchGraph(`me/chats?${params}`);
          return (data.value ?? []).map((c: any) => ({
            id: c.id,
            topic: c.topic,
            type: c.chatType,
            members: (c.members ?? []).map((m: any) => m.displayName).filter(Boolean),
            lastMessage: c.lastMessagePreview
              ? {
                  from: c.lastMessagePreview.from?.user?.displayName,
                  sent: c.lastMessagePreview.createdDateTime,
                  text: htmlToText(c.lastMessagePreview.body?.content ?? '').slice(0, 300),
                }
              : undefined,
            url: c.webUrl,
          }));
        }),
    }),

    readTeamsChat: tool({
      description: '[Microsoft Teams] Read the latest messages of one Teams chat.',
      inputSchema: z.object({
        chatId: graphId,
        limit: z.number().int().min(1).max(50).optional().describe('How many (default 20)'),
      }),
      execute: async ({ chatId, limit }) =>
        safeExecute('Microsoft Teams', async () => {
          const params = new URLSearchParams({
            $top: String(limit ?? 20),
            $orderby: 'createdDateTime desc',
          });
          const data = await fetchGraph(`chats/${graphPath(chatId)}/messages?${params}`);
          return (data.value ?? []).filter((m: any) => m.messageType === 'message').map(messageOf);
        }),
    }),

    sendTeamsChatMessage: tool({
      description: '[Microsoft Teams] Send a message in one of the person’s Teams chats.',
      inputSchema: z.object({ chatId: graphId, text: z.string().min(1).max(28_000) }),
      execute: async ({ chatId, text }) =>
        safeExecute('Microsoft Teams', async () => {
          const data = await fetchGraph(`chats/${graphPath(chatId)}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: { contentType: 'text', content: text } }),
          });
          return { sent: true, id: data.id, chatId };
        }),
    }),

    listTeams: tool({
      description: '[Microsoft Teams] List the teams the person is a member of.',
      inputSchema: z.object({}),
      execute: async () =>
        safeExecute('Microsoft Teams', async () => {
          const data = await fetchGraph('me/joinedTeams?$select=id,displayName,description');
          return (data.value ?? []).map((t: any) => ({
            id: t.id,
            name: t.displayName,
            description: t.description,
          }));
        }),
    }),

    listTeamsChannels: tool({
      description: '[Microsoft Teams] List the channels of one team.',
      inputSchema: z.object({ teamId: graphId }),
      execute: async ({ teamId }) =>
        safeExecute('Microsoft Teams', async () => {
          const data = await fetchGraph(
            `teams/${graphPath(teamId)}/channels?$select=id,displayName,description,webUrl,membershipType`,
          );
          return (data.value ?? []).map((c: any) => ({
            id: c.id,
            name: c.displayName,
            description: c.description,
            membership: c.membershipType,
            url: c.webUrl,
          }));
        }),
    }),

    postTeamsChannelMessage: tool({
      description: '[Microsoft Teams] Post a new message in a Teams channel.',
      inputSchema: z.object({
        teamId: graphId,
        channelId: graphId,
        text: z.string().min(1).max(28_000),
        subject: z.string().max(255).optional(),
      }),
      execute: async ({ teamId, channelId, text, subject }) =>
        safeExecute('Microsoft Teams', async () => {
          const data = await fetchGraph(
            `teams/${graphPath(teamId)}/channels/${graphPath(channelId)}/messages`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...(subject ? { subject } : {}),
                body: { contentType: 'text', content: text },
              }),
            },
          );
          return { sent: true, id: data.id, teamId, channelId, url: data.webUrl };
        }),
    }),
  };
}

// ---------------------------------------------------------------------------
// SharePoint and OneDrive
// ---------------------------------------------------------------------------

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|javascript|x-yaml|yaml|markdown))/;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|html?|ya?ml|log|ini|js|ts|py|sql)$/i;
const CONVERTIBLE_EXTENSIONS =
  /\.(docx?|docm|dotx?|pptx?|ppsx?|potx?|xlsx?|xlsm|odt|odp|ods|rtf|epub|eml|msg)$/i;

export function readStrategyOf(
  name: string,
  mimeType: string | undefined,
): 'text' | 'pdf' | 'convert' | 'none' {
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if ((mimeType && TEXT_TYPES.test(mimeType)) || TEXT_EXTENSIONS.test(name)) return 'text';
  if (CONVERTIBLE_EXTENSIONS.test(name)) return 'convert';
  return 'none';
}

export function buildSharePointTools(userId: string): ToolSet {
  const service = 'microsoft-sharepoint';

  return {
    searchSharePointFiles: tool({
      description:
        '[SharePoint] Search the files the person can open in SharePoint, OneDrive and Teams.',
      inputSchema: z.object({
        search: z.string().min(1).max(500).describe('Words in the file name or content'),
        limit: z.number().int().min(1).max(25).optional().describe('How many (default 10)'),
      }),
      execute: async ({ search, limit }) =>
        safeExecute('SharePoint', async () => {
          const data = await authedFetch(userId, service, `${GRAPH}/search/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requests: [
                {
                  entityTypes: ['driveItem'],
                  query: { queryString: search },
                  from: 0,
                  size: limit ?? 10,
                },
              ],
            }),
          });
          const hits = data.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
          return hits.map((hit: any) => {
            const r = hit.resource ?? {};
            return {
              driveId: r.parentReference?.driveId,
              itemId: r.id,
              name: r.name,
              summary: typeof hit.summary === 'string' ? htmlToText(hit.summary) : undefined,
              modified: r.lastModifiedDateTime,
              modifiedBy: r.lastModifiedBy?.user?.displayName,
              size: r.size,
              url: r.webUrl,
            };
          });
        }),
    }),

    readSharePointFile: tool({
      description:
        '[SharePoint] Read the text of a file from SharePoint or OneDrive: Word, Excel, PowerPoint, PDF and text files.',
      inputSchema: z.object({
        driveId: graphId.describe('driveId from a search result'),
        itemId: graphId.describe('itemId from a search result'),
      }),
      execute: async ({ driveId, itemId }) =>
        safeExecute('SharePoint', async () => {
          const item = `${GRAPH}/drives/${graphPath(driveId)}/items/${graphPath(itemId)}`;
          const meta = await authedFetch(
            userId,
            service,
            `${item}?$select=id,name,size,webUrl,file,lastModifiedDateTime`,
          );
          const name: string = meta.name ?? '';
          const base = { name, url: meta.webUrl, modified: meta.lastModifiedDateTime };
          const strategy = readStrategyOf(name, meta.file?.mimeType);
          if (strategy === 'none') {
            return { ...base, content: null, note: 'This kind of file has no text to read.' };
          }
          const url = strategy === 'convert' ? `${item}/content?format=pdf` : `${item}/content`;
          const { bytes } = await authedFetchBytes(userId, service, url, MAX_FILE_BYTES);
          const text = strategy === 'text' ? new TextDecoder().decode(bytes) : await pdfText(bytes);
          return { ...base, content: clip(text) };
        }),
    }),
  };
}
