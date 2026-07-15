import { tool } from 'ai';
import { z } from 'zod';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

const WHATSAPP_GATEWAY_URL = process.env.WHATSAPP_GATEWAY_URL;
const WHATSAPP_GATEWAY_SECRET = process.env.WHATSAPP_GATEWAY_SECRET;

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

async function gatewayFetch<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  if (!WHATSAPP_GATEWAY_URL || !WHATSAPP_GATEWAY_SECRET) {
    throw new Error('WhatsApp gateway not configured');
  }

  const res = await fetch(`${WHATSAPP_GATEWAY_URL}${path}`, {
    ...options,
    headers: {
      'X-Gateway-Secret': WHATSAPP_GATEWAY_SECRET,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gateway ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Get the user's recent WhatsApp conversations.
 */
export function createGetWhatsAppChatsTool(userId: string) {
  return tool({
    description: 'Get the user\'s recent WhatsApp conversations. Returns chat names, unread counts, and last message previews.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const data = await gatewayFetch<{ chats?: WhatsAppChatSummary[] }>(`/sessions/${userId}/chats`);
        const chats = data.chats || [];

        if (chats.length === 0) {
          return { success: true, message: 'No WhatsApp chats found. The session may still be syncing.' };
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
    description: 'Get recent messages from a specific WhatsApp chat. First use getWhatsAppChats to find the chat name and JID.',
    inputSchema: z.object({
      jid: z.string().describe('The chat JID (e.g. "1234567890@s.whatsapp.net"). Get this from getWhatsAppChats.'),
      limit: z.number().optional().default(20).describe('Number of messages to fetch (max 50)'),
    }),
    execute: async ({ jid, limit }) => {
      try {
        const data = await gatewayFetch<{ messages?: WhatsAppMessageSummary[] }>(`/sessions/${userId}/chats/${encodeURIComponent(jid)}/messages?limit=${limit}`);
        const messages = data.messages || [];

        if (messages.length === 0) {
          return { success: true, message: 'No messages found in this chat.' };
        }

        return {
          success: true,
          messages: messages.map((m) => ({
            from: m.fromMe ? 'You' : (m.pushName || 'Unknown'),
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
    description: 'Send a WhatsApp message. Use ONLY when the user explicitly asks to send a message on WhatsApp. First use getWhatsAppChats to find the recipient JID.',
    inputSchema: z.object({
      jid: z.string().describe('The recipient JID (e.g. "1234567890@s.whatsapp.net"). Get this from getWhatsAppChats.'),
      message: z.string().describe('The message text to send'),
    }),
    execute: async ({ jid, message }) => {
      try {
        const data = await gatewayFetch<{ messageId?: string }>(`/sessions/${userId}/send`, {
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
