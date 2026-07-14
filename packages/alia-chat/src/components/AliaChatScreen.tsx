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
 */

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AliaChatContent } from './AliaChatContent';
import { AliaMark } from './AliaMark';
import type { WelcomeSuggestion } from './AliaWelcomeMessage';

export interface AliaChatScreenProps {
  /** App context injected into system prompt */
  clientContext?: string;
  /** Alia model (default: 'alia-v1') */
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
        header={({ markState, hasMessages, clear }) => (
          <View className="flex-row items-center justify-between px-4 py-3">
            <View className="flex-row items-center gap-2.5">
              {headerLeft}
              <AliaMark size={28} state={markState} />
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
