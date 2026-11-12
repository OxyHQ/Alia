/** Keep the saver's admitted identities on the same message objects used by final persistence. */
import { usableMessageId } from '../../../domain/conversation.js';
import { randomUUID } from 'node:crypto';
import { saveConversation } from '../../conversation-saver.js';
import type { ChatMessage } from '../../message-converter.js';

export async function admitAgentReactionMessages(input: {
  userId: string;
  conversationId: string;
  agentId: string;
  messages: ChatMessage[];
  originApp?: string;
}) {
  // Fresh server identities cannot inherit feedback from positional, unidentified client edits.
  // Assign before admission: unseen durable replies can shift the saver's merged positions.
  for (const message of input.messages) {
    if (!message || !message.role || message.content === undefined) continue;
    if (usableMessageId(message.id) === undefined) message.id = randomUUID();
  }
  await saveConversation({ ...input, assistantResponse: '', omitLeadReply: true });
}
