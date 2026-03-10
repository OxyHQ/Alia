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
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AliaChatContent, type AliaChatContentRef } from './AliaChatContent';
import { AliaFace, type AliaExpression } from './AliaFace';
import { useAliaColors } from '../theme';
import type { AliaChatSuggestion } from '../types';

export interface AliaChatScreenProps {
  /** App context injected into system prompt */
  clientContext?: string;
  /** Quick action suggestions shown when chat is empty */
  suggestions?: AliaChatSuggestion[];
  /** Alia model (default: 'alia-v1') */
  model?: string;
  /** API URL override */
  apiUrl?: string;
  /** Optional header left action (e.g., back button) */
  headerLeft?: React.ReactNode;
  /** Optional header right action (e.g., settings button) */
  headerRight?: React.ReactNode;
}

export function AliaChatScreen({
  clientContext,
  suggestions = [],
  model,
  apiUrl,
  headerLeft,
  headerRight,
}: AliaChatScreenProps) {
  const colors = useAliaColors();
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
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {headerLeft}
          <AliaFace size={28} expression={faceExpression} />
          <Text style={[styles.headerTitle, { color: colors.text }]}>Alia</Text>
        </View>
        <View style={styles.headerRight}>
          {hasMessages && (
            <TouchableOpacity onPress={handleClear} style={styles.clearButton}>
              <Text style={[styles.clearText, { color: colors.secondaryText }]}>Clear</Text>
            </TouchableOpacity>
          )}
          {headerRight}
        </View>
      </View>

      {/* Chat content */}
      <AliaChatContent
        ref={contentRef}
        clientContext={clientContext}
        suggestions={suggestions}
        model={model}
        apiUrl={apiUrl}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  clearButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  clearText: {
    fontSize: 14,
  },
});
