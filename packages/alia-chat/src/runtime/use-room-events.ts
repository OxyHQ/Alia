import { useEffect } from 'react';
import { useAliaRuntime } from './config';
import { applyRoomEvent, type RoomLedger } from './room-events';
import type { Message } from './types';

/**
 * While a conversation is open, fold its room's events (`group:event`, ADR 0025) into the thread.
 * Only a group has a room, so for any other conversation the host never sends one. A host without
 * `subscribeRoomEvents` has no live room: members' replies then arrive on reload.
 */
export function useRoomEvents(
  conversationId: string | undefined,
  ledger: RoomLedger,
  setMessages: (update: (prev: Message[]) => Message[]) => void,
): void {
  const { host } = useAliaRuntime();
  const subscribe = host.subscribeRoomEvents;
  useEffect(() => {
    if (!conversationId || !subscribe) return;
    return subscribe(conversationId, (event) => {
      setMessages((prev) => applyRoomEvent(prev, ledger, conversationId, event));
    });
  }, [conversationId, ledger, subscribe, setMessages]);
}
