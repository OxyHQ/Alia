import { useTTS } from '@/features/voice/runtime/use-tts';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useSTTStore } from '@alia.onl/sdk';
import type { AiChatTurnAction } from '@oxy.so/bloom/ai-chat';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@oxy.so/bloom/context-menu';
import { toast } from '@oxy.so/bloom/toast';
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Platform } from 'react-native';

/**
 * What a turn in the thread can do besides being read: copy, read aloud,
 * regenerate, edit (#608 §7). The row draws them with Bloom's turn actions —
 * the feedback row under a reply, the action row under a question — and on a
 * phone the same list is a long-press menu.
 */

type Translate = (key: string) => string;

/**
 * Copy `text`, and say which happened.
 *
 * The result is the clipboard's own: `setStringAsync` resolves `false` on web
 * when the browser refuses (no permission, no focus, an insecure origin) and
 * rejects on native when the module is missing. Either way the answer is
 * `false` and an error toast, and Bloom's copy button, which confirms only on
 * `true`, stays a copy glyph instead of announcing "Copied!" over nothing.
 */
export async function copyText(text: string, t: Translate): Promise<boolean> {
  let copied: boolean;
  try {
    copied = (await Clipboard.setStringAsync(text)) !== false;
  } catch {
    copied = false;
  }
  if (copied) toast.success(t('chat.copiedToClipboard'));
  else toast.error(t('chat.copyFailed'));
  return copied;
}

// ---------------------------------------------------------------------------
//  Read aloud
// ---------------------------------------------------------------------------

export type ReadAloudState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/**
 * The screen whose player is sounding, if any.
 *
 * `useTTS` keeps its player PER HOOK INSTANCE while the playback state is one
 * shared store — and the drawer keeps every visited chat mounted, each with its
 * own thread and so its own instance. Starting a reply in one chat must stop a
 * reply still playing in another, and only the instance that owns a player can
 * stop it. So the owner registers its `stop` here, and anyone may call it.
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
 * - A press starts it; a second press on the same reply stops it — not the
 *   SDK's pause, which would leave a half-read reply parked with nothing on
 *   screen saying so.
 * - `blocked` is a call or a dictation holding the audio: the button is
 *   disabled, and anything already being read stops when either starts. Two
 *   voices at once, or the microphone recording Alia's own voice into the
 *   draft, is the thing this prevents (#608 §9).
 * - A failure is a toast, and the button goes back to idle.
 */
export function useReadAloud(blocked: boolean) {
  const { t } = useTranslation();
  const { readAloud, stop, activeMessageId, playbackState } = useTTS();
  const self = useRef<{ stop: () => void }>({ stop });
  self.current.stop = stop;
  const owns = owner === self.current && activeMessageId !== null;

  // A call or a dictation began: whatever is being read stops, wherever.
  const dictating = useSTTStore((s) => s.isRecording);
  const busy = blocked || dictating;
  useEffect(() => {
    if (busy) stopReadingAloud();
  }, [busy]);

  useEffect(() => {
    if (!owns || playbackState !== 'error') return;
    toast.error(t('chat.readAloudFailed'));
    stopReadingAloud();
  }, [owns, playbackState, t]);

  // Leaving takes the player with it (`useTTS` releases it); the shared state
  // has to go too, or every other screen would show a reply still playing.
  useEffect(() => {
    const me = self.current;
    return () => {
      if (owner === me) stopReadingAloud();
    };
  }, []);

  const active = useRef(activeMessageId);
  active.current = activeMessageId;
  const toggle = useCallback(
    (messageId: string, text: string, audioUrl?: string, conversationId?: string) => {
      const wasThis = active.current === messageId;
      stopReadingAloud();
      if (wasThis) return;
      owner = self.current;
      /**
       * `conversationId` asks the route to STORE the clip on the message,
       * found by this same id — so the next press, here or after a reload,
       * plays it without making it again. The caller passes it only for a
       * message the server holds (`Message.unsaved`): for one it does not, the
       * route answers 404 and nothing would be read. Without it the clip is
       * simply made and played.
       */
      void readAloud(messageId, text, conversationId, audioUrl);
    },
    [readAloud],
  );

  const stateOf = useCallback(
    (messageId: string): ReadAloudState =>
      activeMessageId === messageId ? playbackState : 'idle',
    [activeMessageId, playbackState],
  );

  return { toggle, stateOf, blocked: busy };
}

// ---------------------------------------------------------------------------
//  Long press
// ---------------------------------------------------------------------------

/**
 * The turn's actions as a long-press menu, on native.
 *
 * A phone has no hover, and the action rows are small targets under a long
 * reply; a long press anywhere on the turn is where people look for them, and
 * it is what the thread offered before the template. Web keeps the rows alone:
 * there a right-click on a reply is the browser's own menu, with the text
 * selection in it, and taking that away to show the same buttons again would
 * be a loss.
 */
const STRETCH = { alignSelf: 'stretch' } as const;

export function TurnMenu({
  actions,
  label,
  children,
}: {
  actions: ReadonlyArray<AiChatTurnAction>;
  label: string;
  children: ReactNode;
}) {
  if (Platform.OS === 'web' || actions.length === 0) return <>{children}</>;
  return (
    <ContextMenu>
      {/* Stretched: Bloom's trigger hugs its content by default, and a turn
          measures the column it is in (a question is half of it). */}
      <ContextMenuTrigger label={label} style={STRETCH}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map(({ key, label: rowLabel, icon: Icon, onPress, disabled }) => (
          <ContextMenuItem
            key={key}
            onPress={onPress}
            disabled={disabled}
            leading={<Icon size="sm" />}
          >
            {rowLabel}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
