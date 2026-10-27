/**
 * What a share link shows: the conversation's words, its images, who said
 * them, and the canvas artifacts Alia drew in it — and nothing else
 * (`GET /v1/shared/:token`, `docs/agent-embedding.md` §6).
 *
 * Built as an ALLOW-list over what is stored. A tool's input or output is the
 * person's own data fetched from their apps (their inbox, their listings), so
 * it never leaves through a link the person may forward; neither does a
 * document they attached (`file` parts), the model's reasoning, or a system or
 * tool row. Anything a future client stores in a new part type is left out
 * until somebody decides it belongs here.
 *
 * The one tool result that does leave is a canvas artifact — the report, deck,
 * dashboard, chart or table Alia made for the person — because sharing the
 * artifact is what sharing the chat is for (owner, 2026-10-27). Only the
 * `canvas` tool's finished result, and only its `type`, `title` and `data`:
 * never its arguments, a refused call, or any other tool (`generateFile`,
 * email, files, connected apps, page text, host tools).
 */

import type { AvatarCharacter } from '@oxy.so/contracts';
import type { MessageRow } from '../db/chat/messageRepository.js';
import { CANVAS_TYPES } from './tools/canvas.js';

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

/** A canvas artifact as the link shows it: `id` is the tool call that drew it. */
export interface SharedArtifact {
  readonly id: string;
  readonly type: (typeof CANVAS_TYPES)[number];
  readonly title: string;
  readonly data: unknown;
}

export interface SharedMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | SharedContentPart[];
  readonly agent?: SharedAgent;
  readonly artifacts?: SharedArtifact[];
}

const SHAREABLE_CANVAS_TYPES: ReadonlySet<string> = new Set(CANVAS_TYPES);

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

/** The canvas artifacts an assistant row's tool calls drew, in call order. */
export function sharedArtifactsOf(toolInvocations: unknown): SharedArtifact[] {
  if (!Array.isArray(toolInvocations)) return [];
  return toolInvocations.flatMap((invocation, index): SharedArtifact[] => {
    if (invocation === null || typeof invocation !== 'object') return [];
    const call = invocation as Record<string, unknown>;
    if (call.toolName !== 'canvas' || call.state !== 'result') return [];
    const result = call.result;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return [];
    const { type, title, data } = result as Record<string, unknown>;
    if (typeof type !== 'string' || !SHAREABLE_CANVAS_TYPES.has(type)) return [];
    if (data === undefined || data === null) return [];
    return [
      {
        id: typeof call.toolCallId === 'string' ? call.toolCallId : `canvas-${index}`,
        type: type as SharedArtifact['type'],
        title: typeof title === 'string' ? title : '',
        data,
      },
    ];
  });
}

/** The stored thread, reduced to what a link may show, in thread order. */
export function sharedMessagesOf(rows: readonly MessageRow[]): SharedMessage[] {
  return rows.flatMap((row): SharedMessage[] => {
    if (row.role !== 'user' && row.role !== 'assistant') return [];
    const artifacts = row.role === 'assistant' ? sharedArtifactsOf(row.toolInvocations) : [];
    const content = sharedParts(row.content) ?? (artifacts.length > 0 ? '' : null);
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
        ...(artifacts.length === 0 ? {} : { artifacts }),
      },
    ];
  });
}
