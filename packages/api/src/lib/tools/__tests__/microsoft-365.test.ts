import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../integration-token.js', () => ({
  getValidToken: vi.fn(async () => 'graph-access-token'),
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/integrations/integrationRepository.js', () => ({
  touchIntegrationLastUsed: vi.fn(async () => undefined),
}));
vi.mock('../../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../files/pdf-text.js', () => ({
  pdfText: vi.fn(async (bytes: Uint8Array) => `pdf text of ${bytes.byteLength} bytes`),
}));

import { classifyActionRisk } from '../../agent/governance.js';
import { getValidToken } from '../../integration-token.js';
import {
  buildOutlookTools,
  buildSharePointTools,
  buildTeamsTools,
  graphSearchTerm,
  htmlToText,
  readStrategyOf,
} from '../integrations/microsoft-365.js';

type Call = [string, RequestInit | undefined];

function jsonReply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function run(tools: Record<string, any>, name: string, input: Record<string, unknown>) {
  return tools[name].execute(input, { toolCallId: 't', messages: [] });
}

/** Graph `GET /me/messages?$search=…`, as recorded (values replaced). */
const MESSAGES = {
  '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#users('id')/messages",
  value: [
    {
      id: 'AAMkAGI2THVSAAA=',
      subject: 'Q3 budget review',
      bodyPreview: 'Attached is the draft budget for Q3…',
      isRead: false,
      hasAttachments: true,
      receivedDateTime: '2026-10-27T15:04:11Z',
      webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGI2THVSAAA%3D',
      from: { emailAddress: { name: 'Megan Bowen', address: 'MeganB@contoso.example' } },
      toRecipients: [{ emailAddress: { name: 'Adele Vance', address: 'AdeleV@contoso.example' } }],
    },
  ],
};

describe('Microsoft 365 tools', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const calls = (): Call[] => fetchMock.mock.calls as Call[];

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  describe('Outlook', () => {
    it('searches mail with KQL that cannot close its own quotes', async () => {
      fetchMock.mockResolvedValue(jsonReply(MESSAGES));
      const out = await run(buildOutlookTools('u1'), 'searchOutlookMail', {
        search: 'budget" OR "everything',
      });

      const url = new URL(calls()[0]![0]);
      expect(url.pathname).toBe('/v1.0/me/messages');
      expect(url.searchParams.get('$search')).toBe('"budget  OR  everything"');
      expect(calls()[0]![1]?.headers).toMatchObject({ Authorization: 'Bearer graph-access-token' });
      expect(getValidToken).toHaveBeenCalledWith('u1', 'microsoft-outlook');
      expect(out).toEqual([
        expect.objectContaining({
          id: 'AAMkAGI2THVSAAA=',
          subject: 'Q3 budget review',
          from: 'Megan Bowen <MeganB@contoso.example>',
          isRead: false,
        }),
      ]);
    });

    it('lists a folder newest first when there is no search', async () => {
      fetchMock.mockResolvedValue(jsonReply({ value: [] }));
      await run(buildOutlookTools('u1'), 'searchOutlookMail', { unreadOnly: true });
      const url = new URL(calls()[0]![0]);
      expect(url.pathname).toBe('/v1.0/me/mailFolders/inbox/messages');
      expect(url.searchParams.get('$filter')).toBe('isRead eq false');
      expect(url.searchParams.get('$orderby')).toBe('receivedDateTime desc');
    });

    it('reads a message as text and encodes its id into the path', async () => {
      fetchMock.mockResolvedValue(
        jsonReply({
          id: 'a/b',
          subject: 'Hi',
          body: { contentType: 'text', content: 'Plain body' },
          from: { emailAddress: { name: 'M', address: 'm@x.example' } },
        }),
      );
      const out = await run(buildOutlookTools('u1'), 'readOutlookMail', { messageId: 'a/b' });
      expect(calls()[0]![0]).toContain('/me/messages/a%2Fb?');
      expect(calls()[0]![1]?.headers).toMatchObject({ Prefer: 'outlook.body-content-type="text"' });
      expect(out.body).toBe('Plain body');
    });

    it('sends mail, taking Graph’s empty 202 as success', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
      const out = await run(buildOutlookTools('u1'), 'sendOutlookMail', {
        to: ['megan@contoso.example'],
        subject: 'Notes',
        body: 'See you at 3.',
      });
      expect(out).toEqual({ sent: true, to: ['megan@contoso.example'], subject: 'Notes' });
      const [url, init] = calls()[0]!;
      expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
      expect(JSON.parse(init!.body as string)).toEqual({
        message: {
          subject: 'Notes',
          body: { contentType: 'Text', content: 'See you at 3.' },
          toRecipients: [{ emailAddress: { address: 'megan@contoso.example' } }],
        },
        saveToSentItems: true,
      });
    });

    it('answers a Graph refusal as an error the model can read, without throwing', async () => {
      fetchMock.mockResolvedValue(
        jsonReply({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, 403),
      );
      const out = await run(buildOutlookTools('u1'), 'searchOutlookMail', { search: 'x' });
      expect(out.error).toMatch(/^Could not access Outlook: .*403/);
    });

    it('lists calendar events in UTC between the asked times', async () => {
      fetchMock.mockResolvedValue(
        jsonReply({
          value: [
            {
              id: 'ev1',
              subject: 'Standup',
              start: { dateTime: '2026-10-28T09:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2026-10-28T09:15:00.0000000', timeZone: 'UTC' },
              location: { displayName: '' },
              onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' },
            },
          ],
        }),
      );
      const out = await run(buildOutlookTools('u1'), 'listOutlookEvents', {
        start: '2026-10-28T00:00:00Z',
        end: '2026-10-29T00:00:00Z',
      });
      const url = new URL(calls()[0]![0]);
      expect(url.pathname).toBe('/v1.0/me/calendarView');
      expect(url.searchParams.get('startDateTime')).toBe('2026-10-28T00:00:00.000Z');
      expect(out[0]).toMatchObject({
        subject: 'Standup',
        start: '2026-10-28T09:00:00.0000000Z',
        joinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
      });
    });
  });

  describe('Teams', () => {
    it('reads a chat as text, leaving out system events', async () => {
      fetchMock.mockResolvedValue(
        jsonReply({
          value: [
            {
              id: '1616990417393',
              messageType: 'message',
              createdDateTime: '2026-10-27T10:00:17Z',
              from: { user: { displayName: 'Megan Bowen' } },
              body: { contentType: 'html', content: '<p>Ship it&nbsp;<b>today</b></p>' },
            },
            {
              id: '1616990000000',
              messageType: 'systemEventMessage',
              body: { contentType: 'html', content: '<systemEventMessage/>' },
            },
          ],
        }),
      );
      const out = await run(buildTeamsTools('u1'), 'readTeamsChat', { chatId: '19:abc@thread.v2' });
      expect(calls()[0]![0]).toContain('/chats/19%3Aabc%40thread.v2/messages?');
      expect(getValidToken).toHaveBeenCalledWith('u1', 'microsoft-teams');
      expect(out).toEqual([
        {
          id: '1616990417393',
          from: 'Megan Bowen',
          sent: '2026-10-27T10:00:17Z',
          text: 'Ship it today',
        },
      ]);
    });

    it('posts to a channel as plain text', async () => {
      fetchMock.mockResolvedValue(
        jsonReply({ id: 'm1', webUrl: 'https://teams.microsoft.com/l/message/x' }, 201),
      );
      const out = await run(buildTeamsTools('u1'), 'postTeamsChannelMessage', {
        teamId: 't1',
        channelId: '19:general@thread.tacv2',
        text: 'Release is out',
      });
      expect(calls()[0]![0]).toBe(
        'https://graph.microsoft.com/v1.0/teams/t1/channels/19%3Ageneral%40thread.tacv2/messages',
      );
      expect(JSON.parse(calls()[0]![1]!.body as string)).toEqual({
        body: { contentType: 'text', content: 'Release is out' },
      });
      expect(out).toMatchObject({ sent: true, id: 'm1' });
    });
  });

  describe('SharePoint and OneDrive', () => {
    it('searches drive items and returns the ids a read needs', async () => {
      fetchMock.mockResolvedValue(
        jsonReply({
          value: [
            {
              searchTerms: ['roadmap'],
              hitsContainers: [
                {
                  total: 1,
                  moreResultsAvailable: false,
                  hits: [
                    {
                      hitId: '01BYE5RZ',
                      summary: 'The <c0>roadmap</c0> for FY27…',
                      resource: {
                        '@odata.type': '#microsoft.graph.driveItem',
                        id: '01BYE5RZ',
                        name: 'Roadmap.docx',
                        size: 20480,
                        webUrl: 'https://contoso.sharepoint.com/sites/x/Roadmap.docx',
                        lastModifiedDateTime: '2026-10-20T08:00:00Z',
                        parentReference: { driveId: 'b!drive', siteId: 'site' },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
      const out = await run(buildSharePointTools('u1'), 'searchSharePointFiles', {
        search: 'roadmap',
      });
      const body = JSON.parse(calls()[0]![1]!.body as string);
      expect(body.requests[0]).toMatchObject({
        entityTypes: ['driveItem'],
        query: { queryString: 'roadmap' },
      });
      expect(out).toEqual([
        expect.objectContaining({
          driveId: 'b!drive',
          itemId: '01BYE5RZ',
          name: 'Roadmap.docx',
          summary: 'The roadmap for FY27…',
        }),
      ]);
    });

    it('reads a Word document through Graph’s PDF conversion', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonReply({
            id: 'i',
            name: 'Roadmap.docx',
            webUrl: 'https://x',
            file: {
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
          }),
        )
        .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      const out = await run(buildSharePointTools('u1'), 'readSharePointFile', {
        driveId: 'b!drive',
        itemId: 'i',
      });
      expect(calls()[1]![0]).toBe(
        'https://graph.microsoft.com/v1.0/drives/b!drive/items/i/content?format=pdf',
      );
      expect(out.content).toBe('pdf text of 3 bytes');
    });

    it('reads a text file as it is, and says when a file has no text', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonReply({ id: 'i', name: 'notes.md', file: { mimeType: 'text/markdown' } }),
        )
        .mockResolvedValueOnce(new Response('# Notes', { status: 200 }));
      const text = await run(buildSharePointTools('u1'), 'readSharePointFile', {
        driveId: 'd',
        itemId: 'i',
      });
      expect(calls()[1]![0]).toBe('https://graph.microsoft.com/v1.0/drives/d/items/i/content');
      expect(text.content).toBe('# Notes');

      fetchMock.mockResolvedValueOnce(
        jsonReply({ id: 'i', name: 'photo.png', file: { mimeType: 'image/png' } }),
      );
      const image = await run(buildSharePointTools('u1'), 'readSharePointFile', {
        driveId: 'd',
        itemId: 'i',
      });
      expect(image.content).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('refuses a download larger than the limit', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonReply({ id: 'i', name: 'big.txt', file: { mimeType: 'text/plain' } }),
        )
        .mockResolvedValueOnce(
          new Response('x', {
            status: 200,
            headers: { 'Content-Length': String(64 * 1024 * 1024) },
          }),
        );
      const out = await run(buildSharePointTools('u1'), 'readSharePointFile', {
        driveId: 'd',
        itemId: 'i',
      });
      expect(out.error).toContain('too large');
    });
  });

  it('decides how a file is read from its name and type', () => {
    expect(readStrategyOf('a.pdf', undefined)).toBe('pdf');
    expect(readStrategyOf('a.xlsx', 'application/octet-stream')).toBe('convert');
    expect(readStrategyOf('a.csv', undefined)).toBe('text');
    expect(readStrategyOf('a.zip', 'application/zip')).toBe('none');
  });

  it('turns Teams HTML into text', () => {
    expect(htmlToText('<div>a<br>b</div><p>&lt;tag&gt; &amp; more</p>')).toBe('a\nb\n<tag> & more');
    expect(graphSearchTerm('  q4 ')).toBe('"q4"');
  });

  it('runs reads unflagged and flags every send, without asking for approval', () => {
    for (const name of [
      'searchOutlookMail',
      'readOutlookMail',
      'listOutlookEvents',
      'listTeamsChats',
      'readTeamsChat',
      'listTeams',
      'listTeamsChannels',
      'searchSharePointFiles',
      'readSharePointFile',
    ]) {
      expect(classifyActionRisk(name, {}).riskLevel).toBe('R0');
    }
    for (const name of [
      'sendOutlookMail',
      'replyToOutlookMail',
      'createOutlookEvent',
      'sendTeamsChatMessage',
      'postTeamsChannelMessage',
    ]) {
      expect(classifyActionRisk(name, {})).toMatchObject({ riskLevel: 'R2', externalImpact: true });
    }
  });
});
