import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import type { Agent } from '../types/agents';

/**
 * The sidebar's order, exactly as `agentRepository.listAgentsByAuthor` states
 * it: the newest thing said in your thread with the agent, newest first, and an
 * agent nobody has spoken to falls back to when it was made, newest first.
 *
 * A missing `lastMessageAt` sorts LAST — never first. Postgres needs
 * `NULLS LAST` spelled out to do that in a `DESC` order, and the mirror of that
 * mistake here is the ordinary one: an absent value compares `false` against
 * everything, so a comparator that subtracted two timestamps would leave a
 * brand new agent wherever it happened to be rather than below the ones with a
 * thread.
 *
 * `_id` breaks a `createdAt` tie for the same reason the SQL does — two agents
 * made in the same millisecond must not swap places between loads. Both
 * timestamps are ISO-8601 in UTC as the API serialises them, so comparing the
 * strings is comparing the instants.
 */
function byThreadActivity(a: Agent, b: Agent): number {
  const spokenA = a.lastMessageAt ?? null;
  const spokenB = b.lastMessageAt ?? null;
  if (spokenA !== spokenB) {
    if (spokenA === null) return 1;
    if (spokenB === null) return -1;
    return spokenA < spokenB ? 1 : -1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a._id === b._id) return 0;
  return a._id < b._id ? 1 : -1;
}

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
 * ## The row also MOVES, by the server's own rule
 *
 * `listAgentsByAuthor` orders this list by thread activity, so the agent you
 * just spoke to belongs at the top and the next real load will put it there.
 * Writing the line without moving the row would leave the sidebar disagreeing
 * with itself until then — the freshest preview sitting under two older ones.
 *
 * So the same order is applied here, and {@link byThreadActivity} is the one
 * place it is written on this side. It has to say what the SQL says; a client
 * rule of its own invention is the failure this used to avoid by not sorting at
 * all, and it looks the same either way — a row that jumps when the list
 * reloads.
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
        if (!changed) return current;
        // Every other row keeps the position the server gave it: it is the same
        // comparator over the same unchanged fields, so sorting the list again
        // can only move the row whose timestamp just changed.
        return next.sort(byThreadActivity);
      });
    },
    [queryClient],
  );
}
