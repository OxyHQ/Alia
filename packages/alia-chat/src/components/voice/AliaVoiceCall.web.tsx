/**
 * The call of a conversation screen, on web: its bar, while a call is open.
 *
 * Native loads the call lazily (`AliaVoiceCall.tsx`) so a screen that never calls never evaluates
 * `react-native-audio-api`. Web never reaches that engine (`lib/voice-audio-engine.ts` is the Web
 * Audio one), and a lazy `import()` here would be an async chunk boundary inside the SDK: Metro
 * hoists every module two async chunks share into `__common.js`, loaded at first paint, so an app
 * that lazy-loads its Alia sheet would get the chat in its first paint. On web the call is a
 * static import and travels in whatever chunk holds the chat.
 */

import type { VoiceSessionProps } from '../../types';
import { VoiceSession } from './VoiceSession';

export function AliaVoiceCall(props: VoiceSessionProps) {
  return <VoiceSession {...props} />;
}
