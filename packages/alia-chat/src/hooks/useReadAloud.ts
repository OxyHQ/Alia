import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useEffect, useRef } from 'react';
import { useLabels } from '../lib/labels';
import { useAliaRuntime } from '../runtime/config';
import { useDictationStore } from './useDictation';
import { useTTS } from './useTTS';

export type ReadAloudState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/**
 * The screen whose player is sounding, if any.
 *
 * `useTTS` keeps its player PER HOOK INSTANCE while the playback state is one shared store — and
 * a host can keep every visited chat mounted, each with its own thread and so its own instance.
 * Starting a reply in one chat must stop a reply still playing in another, and only the instance
 * that owns a player can stop it. So the owner registers its `stop` here, and anyone may call it.
 */
let owner: { stop: () => void } | null = null;

/** Silence whatever a thread is reading aloud, on any mounted screen. */
export function stopReadingAloud(): void {
  const current = owner;
  owner = null;
  current?.stop();
}

/**
 * Read one reply aloud, as a toggle.
 *
 * - A press starts it; a second press on the same reply stops it — not `useTTS`'s pause, which
 *   would leave a half-read reply parked with nothing on screen saying so.
 * - `blocked` is a call or a dictation holding the audio: the button is disabled, and anything
 *   already being read stops when either starts. Two voices at once, or the microphone recording
 *   Alia's own voice into the draft, is the thing this prevents.
 * - A failure is a toast, and the button goes back to idle.
 *
 * It speaks with the runtime's `apiUrl` and the host's `speech` preferences.
 */
export function useReadAloud(blocked: boolean) {
  const { t } = useLabels();
  const { apiUrl, speech } = useAliaRuntime();
  const { readAloud, stop, activeMessageId, playbackState } = useTTS({ apiUrl, ...speech });
  const self = useRef<{ stop: () => void }>({ stop });
  self.current.stop = stop;
  const owns = owner === self.current && activeMessageId !== null;

  // A call or a dictation began: whatever is being read stops, wherever.
  const dictating = useDictationStore((s) => s.isRecording);
  const busy = blocked || dictating;
  useEffect(() => {
    if (busy) stopReadingAloud();
  }, [busy]);

  useEffect(() => {
    if (!owns || playbackState !== 'error') return;
    toast.error(t('chat.readAloudFailed'));
    stopReadingAloud();
  }, [owns, playbackState, t]);

  // Leaving takes the player with it (`useTTS` releases it); the shared state has to go too, or
  // every other screen would show a reply still playing.
  useEffect(() => {
    const me = self.current;
    return () => {
      if (owner === me) stopReadingAloud();
    };
  }, []);

  const active = useRef(activeMessageId);
  active.current = activeMessageId;
  const toggle = useCallback(
    (messageId: string, text: string, conversationId?: string) => {
      const wasThis = active.current === messageId;
      stopReadingAloud();
      if (wasThis) return;
      owner = self.current;
      // The route makes a clip once and answers every later press — here or after a reload — from
      // storage. `conversationId` files it under the conversation, so deleting that deletes it;
      // the caller passes it only for a message the server holds (`Message.unsaved`): for one it
      // does not, the route answers 404 and nothing would be read.
      void readAloud(messageId, text, conversationId);
    },
    [readAloud],
  );

  const stateOf = useCallback(
    (messageId: string): ReadAloudState => (activeMessageId === messageId ? playbackState : 'idle'),
    [activeMessageId, playbackState],
  );

  return { toggle, stateOf, blocked: busy };
}
