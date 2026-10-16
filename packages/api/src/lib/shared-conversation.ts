/**
 * What a share link shows: the conversation's words, its images and who said
 * them — and nothing else (`GET /v1/shared/:token`, `docs/agent-embedding.md` §6).
 *
 * Built as an ALLOW-list over what is stored. A tool's input or output is the
 * person's own data fetched from their apps (their inbox, their listings), so
 * it never leaves through a link the person may forward; neither does a
 * document they attached (`file` parts), the model's reasoning, or a system or
 * tool row. Anything a future client stores in a new part type is left out
 * until somebody decides it belongs here.
 */

import type { AvatarCharacter } from '@oxy.so/contracts';
import type { MessageRow } from '../db/chat/messageRepository.js';

export type SharedContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

/** An agent as a reader of the link sees it: who spoke, and how they look. */
export interface SharedAgent {
  readonly id: string;
  readonly name: string;
  readonly handle: string;
  readonly color: string | null;
  readonly character: AvatarCharacter | null;
}

export interface SharedMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | SharedContentPart[];
  readonly agent?: SharedAgent;
}

function sharedParts(content: unknown): string | SharedContentPart[] | null {
  if (typeof content === 'string') return content.trim() === '' ? null : content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((part): SharedContentPart[] => {
    if (part === null || typeof part !== 'object') return [];
    const raw = part as Record<string, unknown>;
    if (raw.type === 'text' && typeof raw.text === 'string' && raw.text.trim() !== '') {
      return [{ type: 'text', text: raw.text }];
    }
    const image = raw.image_url as { url?: unknown } | undefined;
    if (raw.type === 'image_url' && typeof image?.url === 'string' && image.url !== '') {
      return [{ type: 'image_url', image_url: { url: image.url } }];
    }
    return [];
  });
  return parts.length === 0 ? null : parts;
}

/** The stored thread, reduced to what a link may show, in thread order. */
export function sharedMessagesOf(rows: readonly MessageRow[]): SharedMessage[] {
  return rows.flatMap((row): SharedMessage[] => {
    if (row.role !== 'user' && row.role !== 'assistant') return [];
    const content = sharedParts(row.content);
    if (content === null) return [];
    return [
      {
        role: row.role,
        content,
        ...(row.agentInfoId === null
          ? {}
          : {
              agent: {
                id: row.agentInfoId,
                name: row.agentInfoName ?? '',
                handle: row.agentInfoHandle ?? '',
                color: row.agentInfoColor,
                character: row.agentInfoCharacter,
              },
            }),
      },
    ];
  });
}
