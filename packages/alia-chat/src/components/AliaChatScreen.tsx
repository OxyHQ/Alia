/**
 * Full-screen Alia chat component for use as a route/screen in Oxy ecosystem apps.
 *
 * Usage:
 * ```tsx
 * import { AliaChatScreen } from '@alia.onl/sdk';
 *
 * <AliaChatScreen
 *   clientContext="Notes app — user is viewing note #42"
 *   suggestions={[{ label: 'Summarize', prompt: 'Summarize this note' }]}
 *   headerLeft={<BackButton />}
 * />
 * ```
 *
 * Voice is opt-in — pass `voiceSession={VoiceSession}` from
 * `@alia.onl/sdk/voice` to offer calls. Without it the screen is text-only and
 * `livekit-client` never enters the bundle.
 */

import React, { useCallback } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from '../lib/keyboard';
import { AliaChatContent, type AliaChatContentProps } from './AliaChatContent';
import { AliaChatHeader } from './AliaChatHeader';
import type { WelcomeSuggestion } from './AliaWelcomeMessage';
import type { AliaChatLabels } from '../lib/labels';
import type { VoiceSessionComponent } from '../types';

export interface AliaChatScreenProps {
  /** App context injected into system prompt */
  clientContext?: string;
  /** Kaana routing profile. Checked against `GET /catalogue`; omitted, the build's preference is used. */
  model?: string;
  /** API URL override */
  apiUrl?: string;
  /** Optional header left action (e.g., back button) */
  headerLeft?: React.ReactNode;
  /** Optional header right action (e.g., settings button) */
  headerRight?: React.ReactNode;
  /** Welcome screen greeting */
  welcomeGreeting?: string;
  /** Welcome screen subtitle */
  welcomeSubtitle?: string;
  /** Welcome screen suggestions */
  welcomeSuggestions?: WelcomeSuggestion[];
  /** Dark-mode flag — forwarded to the ambient wave overlay. */
  isDarkMode?: boolean;
  /** Voice capability — `VoiceSession` from `@alia.onl/sdk/voice`. */
  voiceSession?: VoiceSessionComponent;
  /** Overrides for the chat's own copy (header, composer, plan, research…); omitted, English. */
  labels?: Partial<AliaChatLabels>;
}

export function AliaChatScreen({
  clientContext,
  model,
  apiUrl,
  headerLeft,
  headerRight,
  welcomeGreeting,
  welcomeSubtitle,
  welcomeSuggestions,
  isDarkMode,
  voiceSession,
  labels,
}: AliaChatScreenProps) {
  const insets = useSafeAreaInsets();
  const header = useCallback<NonNullable<AliaChatContentProps['header']>>(
    ({ hasMessages, clear, markState }) => (
      <AliaChatHeader
        markState={markState}
        hasMessages={hasMessages}
        onClear={clear}
        leading={headerLeft}
        trailing={headerRight}
      />
    ),
    [headerLeft, headerRight],
  );

  // The screen owns the whole window, so it keeps its composer out of both
  // system bars: the top inset clears the status bar, the bottom one the
  // gesture bar or home indicator an edge-to-edge app draws over.
  //
  // The keyboard is handled INSIDE the bottom inset. The avoiding view measures
  // its own frame in the window (`automaticOffset`), and that frame already
  // ends `insets.bottom` above the window's edge, so the padding it adds is the
  // keyboard's height minus the inset: the composer sits on the keyboard, not
  // one inset above it. (Its parent-relative layout would read as zero overlap
  // this deep in a host's tree, which is why the offset is measured.)
  return (
    <View
      className="flex-1 bg-background-full"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
        <AliaChatContent
          clientContext={clientContext}
          model={model}
          apiUrl={apiUrl}
          welcomeGreeting={welcomeGreeting}
          welcomeSubtitle={welcomeSubtitle}
          welcomeSuggestions={welcomeSuggestions}
          isDarkMode={isDarkMode}
          voiceSession={voiceSession}
          labels={labels}
          header={header}
        />
      </KeyboardAvoidingView>
    </View>
  );
}
