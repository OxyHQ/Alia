/**
 * Gmail Adapter Types
 *
 * Types for Gmail Connected Account integration.
 * Uses Google REST API directly (no googleapis SDK dependency).
 */

export interface GmailSession {
  sessionId: string;
  oxyUserId: string;
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  status: 'connected' | 'expired' | 'error';
}

export interface GmailThread {
  id: string;
  snippet: string;
  subject: string;
  from: string;
  date: string;
  unread: boolean;
  messageCount: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
  isHtml: boolean;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  threadId?: string;
}
