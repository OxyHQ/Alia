import { useEffect, useRef } from 'react';
import { useAliaRuntime } from './config';
import {
  applyRoomEvent,
  roomFailureReason,
  type RoomFailureReason,
  type RoomLedger,
} from './room-events';
import type { Message } from './types';

/**
 * While a conversation is open, fold its room's events (`group:event`, ADR 0025) into the thread.
 * Only a group has a room, so for any other conversation the host never sends one. A host without
 * `subscribeRoomEvents` has no live room: members' replies then arrive on reload.
 */
/**
 * How long a room may say nothing while a member still shows as typing before the thread stops
 * waiting. Events reach the socket at most once, so a dropped connection can lose the `group.idle`
 * that would have ended it; a member's turn is bounded well inside this, and streaming deltas keep
 * resetting it while anyone is actually speaking.
 */
export const ROOM_SILENCE_MS = 120_000;
const SILENCE_CHECK_MS = 15_000;

export function useRoomEvents(
  conversationId: string | undefined,
  ledger: RoomLedger,
  setMessages: (update: (prev: Message[]) => Message[]) => void,
  onFailure?: (failure: { chainId: string; reason: RoomFailureReason }) => void,
): void {
  const { host } = useAliaRuntime();
  const subscribe = host.subscribeRoomEvents;
  const failureRef = useRef(onFailure);
  failureRef.current = onFailure;
  useEffect(() => {
    if (!conversationId || !subscribe) return;
    let lastEventAt = Date.now();
    const failedChains = new Set<string>();
    const unsubscribe = subscribe(conversationId, (event) => {
      lastEventAt = Date.now();
      setMessages((prev) => applyRoomEvent(prev, ledger, conversationId, event));
      const reason =
        event.event === 'group.idle' && event.data !== null && typeof event.data === 'object'
          ? roomFailureReason((event.data as { reason?: unknown }).reason)
          : null;
      if (
        event.conversationId === conversationId &&
        reason !== null &&
        typeof event.chainId === 'string' &&
        event.chainId !== '' &&
        !failedChains.has(event.chainId)
      ) {
        failedChains.add(event.chainId);
        failureRef.current?.({ chainId: event.chainId, reason });
      }
    });
    // A quiet room whose `group.idle` was lost: end it the way that event would have. Nothing open
    // means `applyRoomEvent` hands back the same array and nothing re-renders.
    const timer = setInterval(() => {
      if (Date.now() - lastEventAt < ROOM_SILENCE_MS) return;
      lastEventAt = Date.now();
      setMessages((prev) =>
        applyRoomEvent(prev, ledger, conversationId, {
          conversationId,
          event: 'group.idle',
          data: { reason: 'silent' },
        }),
      );
    }, SILENCE_CHECK_MS);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [conversationId, ledger, subscribe, setMessages]);
}
