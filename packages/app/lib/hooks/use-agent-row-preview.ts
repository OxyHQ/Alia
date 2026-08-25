import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import type { Agent } from '../types/agents';

/**
 * Keeping the sidebar's agent row current while you are talking to it.
 *
 * The row shows the last line of your thread, which `GET /agents/me` supplies.
 * That query has a five minute `staleTime` and only agent MUTATIONS invalidate
 * it, so nothing about a message reached it: the row showed whatever was true
 * when the list loaded and stayed there.
 *
 * This WRITES the line into the cache rather than invalidating. The text is
 * already in hand at both moments, so a write is instant and costs no request;
 * invalidating would refetch the whole list once per turn, to be told a thing
 * the client just said.
 *
 * ## Twice a turn, never per token
 *
 * The write happens when you send and again when the turn finishes. NOT on each
 * token: the chat screen re-renders roughly twenty times a second while an
 * answer streams, and writing here on every one of those would repaint the
 * whole sidebar at that rate for a preview nobody can read mid-word.
 *
 * ## The server stays the authority
 *
 * The API stores `conversations.last_message` as the ASSISTANT's reply, so the
 * text put here on send — your own message — is an anticipation the server will
 * never confirm. That is deliberate and it resolves itself: the turn-end write
 * replaces it with the reply, which IS what the server stored, so the next real
 * load agrees. Nothing here becomes the source; it only gets there first.
 *
 * ## Position is left alone
 *
 * `listAgentsByAuthor` orders by `created_at DESC` — when the agent was made,
 * not when it last spoke. So talking to one does not move it, and reordering
 * here would invent an order the next load would undo.
 */
export function useAgentRowPreview() {
  const queryClient = useQueryClient();

  return useCallback(
    (agentId: string | null | undefined, text: string): void => {
      // The main chat has no agent, and an empty turn has nothing to preview.
      if (agentId === null || agentId === undefined || agentId.length === 0) return;
      const line = text.trim();
      if (line.length === 0) return;

      queryClient.setQueryData<Agent[]>(queryKeys.agents.mine, (current) => {
        if (current === undefined) return current;
        let changed = false;
        const next = current.map((agent) => {
          if (agent._id !== agentId) return agent;
          changed = true;
          return { ...agent, lastMessage: line, lastMessageAt: new Date().toISOString() };
        });
        // The same array back when this agent is not in the list, so a row that
        // was not touched is not re-rendered for having been rebuilt.
        return changed ? next : current;
      });
    },
    [queryClient],
  );
}
