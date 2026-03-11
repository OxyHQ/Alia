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

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AliaChatContent, type AliaChatContentRef } from './AliaChatContent';
import { AliaFace, type AliaExpression } from './AliaFace';
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
  const contentRef = useRef<AliaChatContentRef>(null);

  const [faceExpression, setFaceExpression] = useState<AliaExpression>('Idle A');
  const [hasMessages, setHasMessages] = useState(false);

  // Poll content ref for header state
  useEffect(() => {
    const interval = setInterval(() => {
      if (contentRef.current) {
        setFaceExpression(contentRef.current.faceExpression);
        setHasMessages(contentRef.current.messages.length > 0);
      }
    }, 200);
    return () => clearInterval(interval);
  }, []);

  const handleClear = useCallback(() => {
    contentRef.current?.clear();
  }, []);

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-3">
        <View className="flex-row items-center gap-2.5">
          {headerLeft}
          <AliaFace size={28} expression={faceExpression} />
          <Text className="text-lg font-semibold text-foreground">Alia</Text>
        </View>
        <View className="flex-row items-center gap-2">
          {hasMessages && (
            <TouchableOpacity onPress={handleClear} className="px-2.5 py-1.5">
              <Text className="text-sm text-muted-foreground">Clear</Text>
            </TouchableOpacity>
          )}
          {headerRight}
        </View>
      </View>

      {/* Chat content */}
      <AliaChatContent
        ref={contentRef}
        clientContext={clientContext}
        model={model}
        apiUrl={apiUrl}
        welcomeGreeting={welcomeGreeting}
        welcomeSubtitle={welcomeSubtitle}
        welcomeSuggestions={welcomeSuggestions}
      />
    </View>
  );
}

