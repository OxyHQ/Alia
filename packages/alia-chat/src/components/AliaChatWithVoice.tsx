/**
 * The chat components of the root entry: each draws the voice call (`withVoiceCall`). The same
 * components without it — and without bundling it — are `@alia.onl/sdk/text`.
 */

import { AliaChatContent as TextChatContent } from './AliaChatContent';
import { AliaChatScreen as TextChatScreen } from './AliaChatScreen';
import { AliaChatSheet as TextChatSheet } from './AliaChatSheet';
import { withVoiceCall } from './voice/withVoiceCall';

export const AliaChatContent = withVoiceCall(TextChatContent, 'AliaChatContent');
export const AliaChatSheet = withVoiceCall(TextChatSheet, 'AliaChatSheet');
export const AliaChatScreen = withVoiceCall(TextChatScreen, 'AliaChatScreen');
