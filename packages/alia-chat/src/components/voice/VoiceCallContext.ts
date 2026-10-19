/**
 * The voice call a conversation can open, handed down by the entry that bundles it.
 *
 * `AliaChatContent` draws the call through this rather than importing it, so a text-only entry
 * (`@alia.onl/sdk/text`, `@alia.onl/sdk/ask/text`) never reaches the call's modules — its socket,
 * protocol and audio engine. The root and `@alia.onl/sdk/ask` provide `AliaVoiceCall` around their
 * chat (`withVoiceCall`); without a provider the chat is text-only, whatever its `voice` prop says.
 */

import { type ComponentType, createContext } from 'react';
import type { VoiceSessionProps } from '../../types';

export const VoiceCallContext = createContext<ComponentType<VoiceSessionProps> | null>(null);
