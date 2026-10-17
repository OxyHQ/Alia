/**
 * The sheet `AliaAskProvider` mounts, in its own module so the provider can load it lazily: an app
 * that mounts the provider at its root carries only the provider in its entry bundle, and the
 * chat — thread, composer, voice, renderers — arrives with the first `ask`.
 *
 * It presents the opening it is handed once it is mounted, which is the only moment a lazily
 * loaded sheet can be presented, and tells the provider the opening is spent.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { AliaTurn } from '../hooks/useChatComposer';
import { AliaChatSheet, type AliaChatSheetProps, type AliaChatSheetRef } from './AliaChatSheet';

/** What the person asked for: a turn to send, or a stored conversation to pick up again. */
export interface AliaAskOpening {
  turn: AliaTurn | undefined;
  conversationId?: string;
  /** Changes on every `ask`, so asking the same agent twice opens twice. */
  serial: number;
}

export interface AliaAskSheetProps extends AliaChatSheetProps {
  /** The opening to present once mounted; `null` when there is none waiting. */
  opening: AliaAskOpening | null;
  /** The opening was presented. */
  onOpened: () => void;
}

export const AliaAskSheet = forwardRef<AliaChatSheetRef, AliaAskSheetProps>(function AliaAskSheet(
  { opening, onOpened, ...sheet },
  ref,
) {
  const sheetRef = useRef<AliaChatSheetRef>(null);
  useImperativeHandle(
    ref,
    () => ({
      present: (turn?: AliaTurn) => sheetRef.current?.present(turn),
      resume: (conversationId: string) => sheetRef.current?.resume(conversationId),
      dismiss: () => sheetRef.current?.dismiss(),
    }),
    [],
  );

  useEffect(() => {
    if (opening === null) return;
    if (opening.conversationId !== undefined) sheetRef.current?.resume(opening.conversationId);
    else sheetRef.current?.present(opening.turn);
    onOpened();
  }, [opening, onOpened]);

  return <AliaChatSheet ref={sheetRef} {...sheet} />;
});
