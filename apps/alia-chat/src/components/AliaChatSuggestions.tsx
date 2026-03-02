import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useAliaColors } from '../theme';
import type { AliaChatSuggestion } from '../types';

interface AliaChatSuggestionsProps {
  suggestions: AliaChatSuggestion[];
  onSelect: (prompt: string) => void;
}

export function AliaChatSuggestions({ suggestions, onSelect }: AliaChatSuggestionsProps) {
  const colors = useAliaColors();
  const isDark = colors.background === '#000000';

  if (suggestions.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={[styles.greeting, { color: colors.tint }]}>
        How can I help you today?
      </Text>
      <View style={styles.list}>
        {suggestions.map((suggestion, i) => (
          <TouchableOpacity
            key={i}
            style={[
              styles.chip,
              { backgroundColor: isDark ? colors.card : colors.card },
            ]}
            onPress={() => onSelect(suggestion.prompt)}
            activeOpacity={0.7}
          >
            <Text style={[styles.chipText, { color: colors.text }]}>
              {suggestion.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  greeting: {
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 32,
    marginBottom: 20,
    paddingHorizontal: 4,
  },
  list: {
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 16,
  },
  chipText: {
    fontSize: 14,
    flex: 1,
  },
});
