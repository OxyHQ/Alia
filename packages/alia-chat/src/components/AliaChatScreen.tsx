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

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from '../lib/keyboard';
import { AliaChatContent } from './AliaChatContent';
import { IdentityMark } from './IdentityMark';
import type { WelcomeSuggestion } from './AliaWelcomeMessage';
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
  /** Theme primary color hex — forwarded to the ambient wave overlay palette. */
  primaryColor?: string;
  /** Dark-mode flag — forwarded to the ambient wave overlay. */
  isDarkMode?: boolean;
  /** Voice capability — `VoiceSession` from `@alia.onl/sdk/voice`. */
  voiceSession?: VoiceSessionComponent;
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
  primaryColor,
  isDarkMode,
  voiceSession,
}: AliaChatScreenProps) {
  const insets = useSafeAreaInsets();

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
      className="flex-1 bg-background"
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
          primaryColor={primaryColor}
          isDarkMode={isDarkMode}
          voiceSession={voiceSession}
          header={({ markState, hasMessages, clear }) => (
            <View className="flex-row items-center justify-between px-4 py-3">
              <View className="flex-row items-center gap-2.5">
                {headerLeft}
                <IdentityMark size={28} state={markState} spinOnPress />
                <Text className="text-lg font-semibold text-foreground">Alia</Text>
              </View>
              <View className="flex-row items-center gap-2">
                {hasMessages && (
                  <TouchableOpacity onPress={clear} className="px-2.5 py-1.5">
                    <Text className="text-sm text-muted-foreground">Clear</Text>
                  </TouchableOpacity>
                )}
                {headerRight}
              </View>
            </View>
          )}
        />
      </KeyboardAvoidingView>
    </View>
  );
}
