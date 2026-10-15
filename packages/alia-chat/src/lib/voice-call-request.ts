import { create } from 'zustand';

/** A call somebody asked for, waiting for the screen that shows its conversation. */
export interface VoiceCallRequest {
  readonly conversationId: string;
  readonly accountId: string | null;
  readonly at: number;
}

/** How long a request waits for its screen. A navigation that never arrives must not open a call later. */
export const CALL_REQUEST_TTL_MS = 15_000;

interface VoiceCallRequestStore {
  request: VoiceCallRequest | null;
  ask: (conversationId: string, accountId: string | null) => void;
  clear: () => void;
}

/**
 * Where a call is asked for, apart from where it opens.
 *
 * Starting a call and showing it are the same thing when the conversation is already on screen,
 * and two screens apart when it is not: a new-chat route makes the conversation and the host
 * navigates to it. Both go the same way. The launcher AND the screen of the conversation meet
 * here — it asks, and whichever launcher is mounted for that conversation (that account, in time)
 * takes the request and opens the call. The sheet, the screen and the app share this one path.
 */
export const useVoiceCallRequests = create<VoiceCallRequestStore>((set) => ({
  request: null,
  ask: (conversationId, accountId) =>
    set({ request: { conversationId, accountId, at: Date.now() } }),
  clear: () => set({ request: null }),
}));

/** Whether `request` is for this conversation and account, and still worth opening. */
export function isRequestFor(
  request: VoiceCallRequest | null,
  conversationId: string | undefined,
  accountId: string | null,
  now = Date.now(),
): boolean {
  return (
    request !== null &&
    conversationId !== undefined &&
    request.conversationId === conversationId &&
    request.accountId === accountId &&
    now - request.at <= CALL_REQUEST_TTL_MS
  );
}
