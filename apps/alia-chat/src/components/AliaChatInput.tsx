import React, { useState } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAliaColors } from '../theme';

interface AliaChatInputProps {
  onSend: (text: string) => void;
  isStreaming: boolean;
}

export function AliaChatInput({ onSend, isStreaming }: AliaChatInputProps) {
  const [input, setInput] = useState('');
  const colors = useAliaColors();
  const insets = useSafeAreaInsets();
  const isDark = colors.background === '#000000';

  const canSend = input.trim().length > 0 && !isStreaming;

  const handleSend = () => {
    if (!canSend) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <View
      style={[
        styles.container,
        {
          borderTopColor: colors.border,
          paddingBottom: Math.max(insets.bottom, 12),
        },
      ]}
    >
      <TextInput
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: isDark ? colors.inputBackground : colors.card,
          },
        ]}
        value={input}
        onChangeText={setInput}
        placeholder="Ask Alia..."
        placeholderTextColor={colors.secondaryText}
        multiline
        maxLength={2000}
        onSubmitEditing={handleSend}
        blurOnSubmit={false}
        editable={!isStreaming}
      />
      <TouchableOpacity
        style={[
          styles.sendButton,
          { backgroundColor: colors.tint },
          !canSend && { opacity: 0.4 },
        ]}
        onPress={handleSend}
        disabled={!canSend}
        activeOpacity={0.7}
      >
        {isStreaming ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <ArrowUpIcon />
        )}
      </TouchableOpacity>
    </View>
  );
}

/** Simple arrow-up SVG as a component to avoid icon library dependency */
function ArrowUpIcon() {
  // Use a unicode character for simplicity — works cross-platform
  return (
    <View style={styles.arrowIcon}>
      {Platform.OS === 'web' ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      ) : (
        // React Native fallback — simple Text arrow
        <View style={styles.arrowIconInner}>
          <View style={[styles.arrowStem, { backgroundColor: '#FFFFFF' }]} />
          <View style={[styles.arrowHead, { borderColor: '#FFFFFF' }]} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    maxHeight: 100,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowIcon: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowIconInner: {
    alignItems: 'center',
  },
  arrowStem: {
    width: 2,
    height: 12,
    borderRadius: 1,
  },
  arrowHead: {
    position: 'absolute',
    top: -1,
    width: 10,
    height: 10,
    borderTopWidth: 2.5,
    borderLeftWidth: 2.5,
    transform: [{ rotate: '45deg' }],
  },
});
