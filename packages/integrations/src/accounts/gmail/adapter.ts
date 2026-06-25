/**
 * Gmail Account Adapter
 *
 * Handles Gmail operations for Connected Accounts.
 * Uses Google REST API directly with OAuth tokens.
 * Sessions are in-memory stores of OAuth tokens indexed by sessionId.
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { errorMessage } from '../../shared/utils';
import type { AccountAdapter } from '../types';
import type { GmailSession, GmailThread, GmailMessage, SendEmailParams } from './types';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_TIMEOUT_MS = 15_000;

// ── Narrow Gmail REST API shapes (only the fields this adapter reads) ──
interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string };
  parts?: GmailPayload[];
}
interface GmailApiMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
}
interface GmailThreadResponse {
  snippet?: string;
  messages?: GmailApiMessage[];
}
interface GmailThreadListResponse {
  threads?: Array<{ id: string }>;
}
interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
}

// In-memory sessions indexed by sessionId
const sessions = new Map<string, GmailSession>();

export class GmailAdapter implements AccountAdapter {
  name = 'gmail';

  async initialize(): Promise<void> {
    // No persistent connections needed for Gmail
  }

  async shutdown(): Promise<void> {
    sessions.clear();
  }

  getRouter(): RouterType {
    const router: RouterType = Router();

    // Create session with OAuth tokens
    router.post('/sessions/connect', async (req: Request, res: Response) => {
      const { oxyUserId, accountId, accessToken, refreshToken, expiresAt, email } = req.body;

      if (!oxyUserId || !accessToken) {
        return res.status(400).json({ error: 'oxyUserId and accessToken are required' });
      }

      const sessionId = accountId || `gmail-${Date.now()}`;

      // Verify token by fetching profile
      let userEmail = email;
      if (!userEmail) {
        try {
          const profile = await getProfile(accessToken);
          userEmail = profile.emailAddress;
        } catch (err: unknown) {
          return res.status(401).json({ error: `Invalid access token: ${errorMessage(err)}` });
        }
      }

      sessions.set(sessionId, {
        sessionId,
        oxyUserId,
        email: userEmail,
        accessToken,
        refreshToken,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        status: 'connected',
      });

      res.json({
        sessionId,
        status: 'connected',
        email: userEmail,
        displayName: userEmail,
      });
    });

    // Get session status
    router.get('/sessions/:id/status', async (req: Request, res: Response) => {
      const session = sessions.get(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Refresh token if expired
      if (session.expiresAt && session.expiresAt < new Date()) {
        const refreshed = await tryRefreshToken(session);
        if (!refreshed) {
          session.status = 'expired';
          return res.json({
            status: 'expired',
            email: session.email,
            displayName: session.email,
          });
        }
      }

      // Verify token is still valid
      try {
        await getProfile(session.accessToken);
        session.status = 'connected';
      } catch {
        session.status = 'expired';
      }

      res.json({
        status: session.status,
        email: session.email,
        displayName: session.email,
        accountId: session.email,
      });
    });

    // List recent email threads (as "chats")
    router.get('/sessions/:id/chats', async (req: Request, res: Response) => {
      const session = sessions.get(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const token = await getValidToken(session);
      if (!token) {
        return res.status(401).json({ error: 'Token expired' });
      }

      try {
        const limit = Number(req.query.limit) || 20;
        const threads = await listThreads(token, limit);
        res.json({ chats: threads });
      } catch (err: unknown) {
        res.status(500).json({ error: errorMessage(err) });
      }
    });

    // Get messages from a thread (as "messages")
    router.get('/sessions/:id/chats/:chatId/messages', async (req: Request, res: Response) => {
      const session = sessions.get(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const token = await getValidToken(session);
      if (!token) {
        return res.status(401).json({ error: 'Token expired' });
      }

      try {
        const messages = await getThreadMessages(token, req.params.chatId);
        res.json({ messages });
      } catch (err: unknown) {
        res.status(500).json({ error: errorMessage(err) });
      }
    });

    // Send email
    router.post('/sessions/:id/send', async (req: Request, res: Response) => {
      const session = sessions.get(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const token = await getValidToken(session);
      if (!token) {
        return res.status(401).json({ error: 'Token expired' });
      }

      const { to, subject, body, inReplyTo, threadId } = req.body;
      if (!to || !body) {
        return res.status(400).json({ error: 'to and body are required' });
      }

      try {
        const result = await sendEmail(token, session.email, {
          to, subject, body, inReplyTo, threadId,
        });
        res.json({ success: true, messageId: result.id });
      } catch (err: unknown) {
        res.status(500).json({ error: errorMessage(err) });
      }
    });

    // Disconnect session
    router.post('/sessions/:id/disconnect', (req: Request, res: Response) => {
      sessions.delete(req.params.id);
      res.json({ success: true });
    });

    return router;
  }
}

// ---------------------------------------------------------------------------
// Google Gmail REST API helpers
// ---------------------------------------------------------------------------

async function getProfile(accessToken: string): Promise<{ emailAddress: string }> {
  const response = await fetch(`${GMAIL_API}/users/me/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Gmail profile failed (${response.status})`);
  }
  return response.json() as Promise<{ emailAddress: string }>;
}

async function listThreads(accessToken: string, maxResults: number): Promise<GmailThread[]> {
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    labelIds: 'INBOX',
  });

  const response = await fetch(`${GMAIL_API}/users/me/threads?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Gmail list threads failed (${response.status})`);
  }

  const data = (await response.json()) as GmailThreadListResponse;
  if (!data.threads?.length) return [];

  // Fetch snippet details for each thread (batched)
  const threads: GmailThread[] = [];
  for (const t of data.threads.slice(0, maxResults)) {
    try {
      const detail = await fetchThreadSummary(accessToken, t.id);
      if (detail) threads.push(detail);
    } catch {
      // Skip threads that fail to load
    }
  }

  return threads;
}

async function fetchThreadSummary(
  accessToken: string,
  threadId: string,
): Promise<GmailThread | null> {
  const response = await fetch(
    `${GMAIL_API}/users/me/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );

  if (!response.ok) return null;

  const data = (await response.json()) as GmailThreadResponse;
  const firstMessage = data.messages?.[0];
  if (!firstMessage) return null;

  const headers = firstMessage.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const labels: string[] = firstMessage.labelIds || [];

  return {
    id: threadId,
    snippet: data.snippet || '',
    subject: getHeader('Subject') || '(No Subject)',
    from: getHeader('From'),
    date: getHeader('Date'),
    unread: labels.includes('UNREAD'),
    messageCount: data.messages?.length || 0,
  };
}

async function getThreadMessages(
  accessToken: string,
  threadId: string,
): Promise<GmailMessage[]> {
  const response = await fetch(
    `${GMAIL_API}/users/me/threads/${threadId}?format=full`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(`Gmail get thread failed (${response.status})`);
  }

  const data = (await response.json()) as GmailThreadResponse;
  if (!data.messages?.length) return [];

  return data.messages.map((msg) => {
    const headers = msg.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    return {
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      body: extractBody(msg.payload),
      date: getHeader('Date'),
      isHtml: isHtmlBody(msg.payload),
    };
  });
}

function extractBody(payload: GmailPayload | undefined): string {
  if (!payload) return '';

  // Simple body
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — prefer text/plain, fallback to text/html
  if (payload.parts) {
    const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return decodeBase64Url(textPart.body.data);
    }

    const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      return decodeBase64Url(htmlPart.body.data);
    }

    // Nested multipart
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return '';
}

function isHtmlBody(payload: GmailPayload | undefined): boolean {
  if (payload?.mimeType === 'text/html') return true;
  if (payload?.parts) {
    const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) return false;
    const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) return true;
  }
  return false;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function encodeBase64Url(str: string): string {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail(
  accessToken: string,
  from: string,
  params: SendEmailParams,
): Promise<{ id: string }> {
  const lines = [
    `From: ${from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject || ''}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];

  if (params.inReplyTo) {
    lines.push(`In-Reply-To: ${params.inReplyTo}`);
    lines.push(`References: ${params.inReplyTo}`);
  }

  lines.push('', params.body);

  const raw = encodeBase64Url(lines.join('\r\n'));
  const body: { raw: string; threadId?: string } = { raw };
  if (params.threadId) body.threadId = params.threadId;

  const response = await fetch(`${GMAIL_API}/users/me/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail send failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<{ id: string }>;
}

async function getValidToken(session: GmailSession): Promise<string | null> {
  if (!session.expiresAt || session.expiresAt > new Date()) {
    return session.accessToken;
  }
  const refreshed = await tryRefreshToken(session);
  return refreshed ? session.accessToken : null;
}

async function tryRefreshToken(session: GmailSession): Promise<boolean> {
  if (!session.refreshToken) return false;

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return false;

  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: session.refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) return false;

    const data = (await response.json()) as GoogleTokenResponse;
    session.accessToken = data.access_token;
    if (data.expires_in) {
      session.expiresAt = new Date(Date.now() + data.expires_in * 1000);
    }
    session.status = 'connected';
    return true;
  } catch {
    return false;
  }
}
