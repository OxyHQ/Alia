/**
 * The call of a conversation screen: its bar, while a call is open.
 *
 * The call and its audio engine load on the first call, not with the chat, so a screen that
 * never calls never evaluates `react-native-audio-api`.
 */

import { lazy, Suspense } from 'react';
import type { VoiceSessionProps } from '../../types';

const VoiceSession = lazy(() =>
  import('./VoiceSession').then((module) => ({ default: module.VoiceSession })),
);

export function AliaVoiceCall(props: VoiceSessionProps) {
  return (
    <Suspense fallback={null}>
      <VoiceSession {...props} />
    </Suspense>
  );
}
