import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { aliaSharedConversationUrl } from '../lib/origins';
import { useAliaApi } from './api';
import { useAliaRuntime } from './config';
import { aliaQueryKeys } from './query-keys';
import { API_ROUTES } from './routes';
import type { Message, ToolInvocation } from './types';

/** A conversation's read-only link (`POST /v1/conversations/:id/share`, `docs/agent-embedding.md` §6). */
export interface AliaConversationShare {
  conversationId: string;
  /** What `GET /v1/shared/:token` reads it by. */
  token: string;
  /** The link to hand on: Alia's one shared-conversation page (`aliaSharedConversationUrl`). */
  url: string;
  expiresAt: string;
}

/** How long a share link lives unless the caller says otherwise, in hours (the API takes 1–168). */
export const DEFAULT_SHARE_TTL_HOURS = 24;

/** Mint and revoke a conversation's share link, as the signed-in person. */
export function useShareConversation() {
  const api = useAliaApi();
  const share = useMutation({
    mutationFn: async ({
      conversationId,
      ttlHours = DEFAULT_SHARE_TTL_HOURS,
    }: {
      conversationId: string;
      ttlHours?: number;
    }): Promise<AliaConversationShare> => {
      const hours = Math.min(168, Math.max(1, Math.round(ttlHours)));
      const { data } = await api.post<{ token?: unknown; expiresAt?: unknown }>(
        API_ROUTES.conversations.share(conversationId),
        { ttlHours: hours },
      );
      if (typeof data?.token !== 'string' || typeof data.expiresAt !== 'string') {
        throw new Error('The share link came back without a token.');
      }
      return {
        conversationId,
        token: data.token,
        url: aliaSharedConversationUrl(data.token),
        expiresAt: data.expiresAt,
      };
    },
  });
  const revoke = useMutation({
    mutationFn: async (conversationId: string): Promise<void> => {
      await api.delete(API_ROUTES.conversations.share(conversationId));
    },
  });
  return useMemo(
    () => ({
      /** Mint the link of `conversationId` (1–168 hours, default 24). */
      share: (conversationId: string, ttlHours?: number) =>
        share.mutateAsync({ conversationId, ttlHours }),
      /** End the link: the token stops answering. */
      revoke: (conversationId: string) => revoke.mutateAsync(conversationId),
      isSharing: share.isPending,
    }),
    [share, revoke],
  );
}

/**
 * A canvas artifact of a shared conversation: the report, deck, dashboard, chart or table Alia drew,
 * as the canvas tool returned it. `id` is the tool call that drew it.
 */
export interface AliaSharedArtifact {
  id: string;
  type: string;
  title: string;
  data: unknown;
}

/**
 * A message of a shared conversation: words and pictures, who wrote them, and the canvas artifacts
 * it drew. Never any other tool's output.
 */
export interface AliaSharedMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; [key: string]: unknown }>;
  agent?: AliaSharedAgent;
  artifacts?: AliaSharedArtifact[];
}

export interface AliaSharedAgent {
  id: string;
  name: string;
  handle?: string;
  character?: unknown;
}

export interface AliaSharedConversationData {
  title: string;
  /** The conversation's lead, when it was an agent's. */
  agent?: AliaSharedAgent;
  messages: AliaSharedMessage[];
  expiresAt: string;
}

/** The agent the server sent, kept only with an id and a name. */
function readSharedAgent(value: unknown): AliaSharedAgent | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { id, name, handle, character } = value as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string') return undefined;
  return {
    id,
    name,
    ...(typeof handle === 'string' ? { handle } : {}),
    ...(character === undefined || character === null ? {} : { character }),
  };
}

/** The artifacts the server sent, each kept only with an id, a type, a title and its data. */
function readSharedArtifacts(value: unknown): AliaSharedArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((artifact): AliaSharedArtifact[] => {
    if (artifact === null || typeof artifact !== 'object') return [];
    const { id, type, title, data } = artifact as Record<string, unknown>;
    if (typeof id !== 'string' || typeof type !== 'string' || type === '') return [];
    if (data === undefined || data === null) return [];
    return [{ id, type, title: typeof title === 'string' ? title : '', data }];
  });
}

/** The shared conversation as the contract names it; any message of another shape is left out. */
export function readSharedConversation(value: unknown): AliaSharedConversationData | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.messages) || typeof raw.expiresAt !== 'string') return null;
  const messages = raw.messages.flatMap((message): AliaSharedMessage[] => {
    if (message === null || typeof message !== 'object') return [];
    const { role, content, agent, artifacts } = message as Record<string, unknown>;
    if (role !== 'user' && role !== 'assistant') return [];
    if (typeof content !== 'string' && !Array.isArray(content)) return [];
    const author = readSharedAgent(agent);
    const drawn = role === 'assistant' ? readSharedArtifacts(artifacts) : [];
    return [
      {
        role,
        content: content as AliaSharedMessage['content'],
        ...(author ? { agent: author } : {}),
        ...(drawn.length > 0 ? { artifacts: drawn } : {}),
      },
    ];
  });
  const lead = readSharedAgent(raw.agent);
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    ...(lead ? { agent: lead } : {}),
    messages,
    expiresAt: raw.expiresAt,
  };
}

/**
 * The shared messages as the thread draws them: an agent's under its own identity, and each artifact
 * as the canvas call that drew it, which the read-only thread draws inline.
 */
export function sharedMessages(shared: AliaSharedConversationData): Message[] {
  return shared.messages.map((message, index) => ({
    id: `shared-${index}`,
    role: message.role,
    content: message.content,
    ...(message.agent ? { agentInfo: { ...message.agent } } : {}),
    ...(message.artifacts
      ? {
          toolInvocations: message.artifacts.map(
            (artifact): ToolInvocation => ({
              toolCallId: artifact.id,
              toolName: 'canvas',
              state: 'result',
              result: { type: artifact.type, title: artifact.title, data: artifact.data },
            }),
          ),
        }
      : {}),
  }));
}

/** Thrown when a token answers nothing: revoked, expired or never minted. */
export class SharedConversationGoneError extends Error {
  constructor() {
    super('This shared conversation is no longer available.');
    this.name = 'SharedConversationGoneError';
  }
}

/**
 * A conversation somebody shared, read by its token. The route needs no session, so it is fetched
 * plainly rather than through the signed-in Oxy client: a person who is not signed in can read it.
 */
export function useSharedConversation(token: string | undefined) {
  const { apiUrl } = useAliaRuntime();
  return useQuery({
    queryKey: aliaQueryKeys.shared(token ?? ''),
    queryFn: async (): Promise<AliaSharedConversationData> => {
      const response = await fetch(new URL(API_ROUTES.shared(token ?? ''), apiUrl).toString(), {
        headers: { Accept: 'application/json' },
      });
      if (response.status === 404 || response.status === 410) {
        throw new SharedConversationGoneError();
      }
      if (!response.ok)
        throw new Error(`Shared conversation failed with status ${response.status}`);
      const shared = readSharedConversation(await response.json());
      if (shared === null) throw new Error('The shared conversation had an unexpected shape.');
      return shared;
    },
    enabled: token !== undefined && token !== '',
    retry: (count, error) => !(error instanceof SharedConversationGoneError) && count < 2,
  });
}
