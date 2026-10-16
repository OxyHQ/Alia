/**
 * What the thread shows while a call is open: the text messages it held when
 * the call started, then the call's messages.
 *
 * A call message the server has stored is shown AS STORED — the copy a reload
 * or a resume shows, with its tools' arguments and results, which the call's
 * socket never carries. Same id either way (the call names every message by the
 * id it is stored under), so swapping one for the other never adds a message.
 */

import type { Message } from '../runtime/types';
import type { VoiceMessage } from '../types';

export function callThread(
  before: readonly Message[],
  call: readonly VoiceMessage[],
  stored: readonly Message[] | undefined,
): Message[] {
  const storedById = new Map((stored ?? []).map((message) => [message.id, message]));
  return [...before, ...call.map((message) => storedById.get(message.id) ?? fromCall(message))];
}

function fromCall(message: VoiceMessage): Message {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    toolInvocations: message.toolInvocations,
    createdAt: new Date(message.timestamp).toISOString(),
    source: 'voice' as const,
    speaker: message.speaker,
  };
}
