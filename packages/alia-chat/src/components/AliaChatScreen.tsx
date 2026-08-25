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
import { AliaChatContent } from './AliaChatContent';
import { IdentityMark } from './IdentityMark';
import type { WelcomeSuggestion } from './AliaWelcomeMessage';
import type { VoiceSessionComponent } from '../types';

export interface AliaChatScreenProps {
  /** App context injected into system prompt */
  clientContext?: string;
  /** Alia model. Checked against `GET /catalogue`; omitted, the build's preference is used. */
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

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
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
    </View>
  );
}
