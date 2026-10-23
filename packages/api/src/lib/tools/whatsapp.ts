import { getDb } from '../../db/index.js';
import { findConnectedAccountForChannel } from '../../db/integrations/connectedAccountRepository.js';
import { integrationsFetch } from '../integrations-client.js';
import { tool } from 'ai';
import { z } from 'zod';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

/**
 * Whether this deployment runs a WhatsApp gateway at all.
 *
 * The three WhatsApp tools are offered only when it does: a tool whose backend
 * is not configured fails on every call, and the model — told it exists — keeps
 * calling it. Read at call time rather than at import, so the answer is the
 * environment's now.
 */
export function whatsAppGatewayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INTEGRATIONS_URL);
}

interface WhatsAppChatSummary {
  name?: string;
  jid?: string;
  unreadCount?: number;
  lastMessagePreview?: string;
  lastMessageTimestamp?: number;
}

interface WhatsAppMessageSummary {
  fromMe?: boolean;
  pushName?: string;
  text?: string;
  timestamp?: number;
}

async function gatewayFetch<T = unknown>(
  userId: string,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const connection = await findConnectedAccountForChannel(getDb(), userId, 'whatsapp');
  if (!connection?.sessionId) throw new Error('WhatsApp account is not connected');
  const res = await integrationsFetch(
    userId,
    `/accounts/whatsapp/sessions/${encodeURIComponent(connection.sessionId)}${path}`,
    {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
    },
  );

  if (!res.ok) {
    throw new Error(`WhatsApp integration request failed (${res.status})`);
  }

  return res.json() as Promise<T>;
}

/**
 * Get the user's recent WhatsApp conversations.
 */
export function createGetWhatsAppChatsTool(userId: string) {
  return tool({
    description:
      "The user's recent WhatsApp chats: names, JIDs, unread counts, last-message previews.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const data = await gatewayFetch<{ chats?: WhatsAppChatSummary[] }>(userId, '/chats');
        const chats = data.chats || [];

        if (chats.length === 0) {
          return {
            success: true,
            message: 'No WhatsApp chats found. The session may still be syncing.',
          };
        }

        return {
          success: true,
          chats: chats.map((c) => ({
            name: c.name,
            jid: c.jid,
            unreadCount: c.unreadCount,
            lastMessage: c.lastMessagePreview || '',
            lastMessageTime: c.lastMessageTimestamp
              ? new Date(c.lastMessageTimestamp * 1000).toISOString()
              : null,
          })),
        };
      } catch (error: unknown) {
        log.tools.error({ err: error }, 'getChats error');
        return { success: false, message: getErrorMessage(error) };
      }
    },
  });
}

/**
 * Get recent messages from a specific WhatsApp chat.
 */
export function createGetWhatsAppMessagesTool(userId: string) {
  return tool({
    description: 'Recent messages of one WhatsApp chat. Get its JID from getWhatsAppChats first.',
    inputSchema: z.object({
      jid: z
        .string()
        .describe(
          'The chat JID (e.g. "1234567890@s.whatsapp.net"). Get this from getWhatsAppChats.',
        ),
      limit: z.number().optional().default(20).describe('Number of messages to fetch (max 50)'),
    }),
    execute: async ({ jid, limit }) => {
      try {
        const data = await gatewayFetch<{ messages?: WhatsAppMessageSummary[] }>(
          userId,
          `/chats/${encodeURIComponent(jid)}/messages?limit=${limit}`,
        );
        const messages = data.messages || [];

        if (messages.length === 0) {
          return { success: true, message: 'No messages found in this chat.' };
        }

        return {
          success: true,
          messages: messages.map((m) => ({
            from: m.fromMe ? 'You' : m.pushName || 'Unknown',
            text: m.text,
            time: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
          })),
        };
      } catch (error: unknown) {
        log.tools.error({ err: error }, 'getMessages error');
        return { success: false, message: getErrorMessage(error) };
      }
    },
  });
}

/**
 * Send a WhatsApp message to a contact or group.
 */
export function createSendWhatsAppMessageTool(userId: string) {
  return tool({
    description:
      'Send a WhatsApp message. ONLY when the user explicitly asks. Get the recipient JID from getWhatsAppChats first.',
    inputSchema: z.object({
      jid: z
        .string()
        .describe(
          'The recipient JID (e.g. "1234567890@s.whatsapp.net"). Get this from getWhatsAppChats.',
        ),
      message: z.string().describe('The message text to send'),
    }),
    execute: async ({ jid, message }) => {
      try {
        const data = await gatewayFetch<{ messageId?: string }>(userId, '/send', {
          method: 'POST',
          body: JSON.stringify({ jid, text: message }),
        });

        return {
          success: true,
          message: 'WhatsApp message sent successfully',
          messageId: data.messageId,
        };
      } catch (error: unknown) {
        log.tools.error({ err: error }, 'sendMessage error');
        return { success: false, message: getErrorMessage(error) };
      }
    },
  });
}
