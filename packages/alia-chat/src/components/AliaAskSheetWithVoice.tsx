/**
 * The ask sheet with the voice call: what the root entry's `AliaAskProvider` imports and
 * `@alia.onl/sdk/ask` loads with the first `ask`. `@alia.onl/sdk/ask/text` loads `AliaAskSheet`
 * itself, which never reaches the call.
 */

import { AliaAskSheet as TextAskSheet } from './AliaAskSheet';
import { withVoiceCall } from './voice/withVoiceCall';

export const AliaAskSheet = withVoiceCall(TextAskSheet, 'AliaAskSheet');
