import React, { useState, useCallback } from 'react';
import {
  View,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSpeechToText } from '../hooks/useSpeechToText';
import { useAliaColors } from '../theme';

interface AliaChatInputProps {
  onSend: (text: string) => void;
  isStreaming: boolean;
  onStop: () => void;
  onVoiceActivate: () => void;
  apiUrl?: string;
}

export function AliaChatInput({
  onSend,
  isStreaming,
  onStop,
  onVoiceActivate,
  apiUrl,
}: AliaChatInputProps) {
  const [input, setInput] = useState('');
  const colors = useAliaColors();
  const insets = useSafeAreaInsets();
  const isDark = colors.isDark;
  const stt = useSpeechToText({ apiUrl });

  const hasText = input.trim().length > 0;
  const canSend = hasText && !isStreaming;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    onSend(input.trim());
    setInput('');
  }, [canSend, input, onSend]);

  const handleMicPress = useCallback(async () => {
    if (stt.isRecording) {
      const text = await stt.stopAndTranscribe();
      if (text) {
        setInput((prev) => (prev ? `${prev} ${text}` : text));
      }
    } else if (!stt.isTranscribing) {
      stt.startRecording();
    }
  }, [stt]);

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
      />

      {/* STT mic button */}
      <Pressable
        onPress={handleMicPress}
        disabled={stt.isTranscribing}
        style={styles.micButton}
      >
        {stt.isTranscribing ? (
          <ActivityIndicator size="small" color="#6366f1" />
        ) : stt.isRecording ? (
          <MicOffIcon />
        ) : (
          <MicIcon color={colors.secondaryText} />
        )}
      </Pressable>

      {/* Three-state submit button */}
      {isStreaming ? (
        <Pressable
          style={[styles.actionButton, { backgroundColor: colors.tint }]}
          onPress={onStop}
        >
          <StopIcon />
        </Pressable>
      ) : hasText ? (
        <Pressable
          style={[
            styles.actionButton,
            { backgroundColor: colors.tint },
            !canSend && { opacity: 0.4 },
          ]}
          onPress={handleSend}
          disabled={!canSend}
        >
          <ArrowUpIcon />
        </Pressable>
      ) : (
        <Pressable
          style={[styles.actionButton, { backgroundColor: colors.tint }]}
          onPress={onVoiceActivate}
        >
          <SoundIcon />
        </Pressable>
      )}
    </View>
  );
}

// ── Icons (inline SVG on web, View-based on native) ──

function ArrowUpIcon() {
  return (
    <View style={styles.iconCenter}>
      {Platform.OS === 'web' ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      ) : (
        <View style={styles.arrowIconInner}>
          <View style={[styles.arrowStem, { backgroundColor: '#FFFFFF' }]} />
          <View style={[styles.arrowHead, { borderColor: '#FFFFFF' }]} />
        </View>
      )}
    </View>
  );
}

function StopIcon() {
  return (
    <View style={styles.iconCenter}>
      {Platform.OS === 'web' ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
      ) : (
        <View style={styles.stopSquare} />
      )}
    </View>
  );
}

function SoundIcon() {
  return (
    <View style={styles.iconCenter}>
      {Platform.OS === 'web' ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5L6 9H2v6h4l5 4V5z" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      ) : (
        <View style={styles.soundBars}>
          <View style={[styles.soundBar, styles.soundBarShort]} />
          <View style={[styles.soundBar, styles.soundBarMed]} />
          <View style={[styles.soundBar, styles.soundBarTall]} />
        </View>
      )}
    </View>
  );
}

function MicIcon({ color }: { color: string }) {
  return (
    <View style={styles.iconCenter}>
      {Platform.OS === 'web' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="1" width="6" height="12" rx="3" />
          <path d="M5 10a7 7 0 0 0 14 0" />
          <line x1="12" y1="17" x2="12" y2="21" />
          <line x1="8" y1="21" x2="16" y2="21" />
        </svg>
      ) : (
        <View style={[styles.micDot, { backgroundColor: color }]} />
      )}
    </View>
  );
}

function MicOffIcon() {
  return (
    <View style={styles.iconCenter}>
      {Platform.OS === 'web' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="1" width="6" height="12" rx="3" />
          <path d="M5 10a7 7 0 0 0 14 0" />
          <line x1="12" y1="17" x2="12" y2="21" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      ) : (
        <View style={[styles.micDot, { backgroundColor: '#ef4444' }]} />
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
  micButton: {
    width: 32,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCenter: {
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
  stopSquare: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
  },
  soundBars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
  },
  soundBar: {
    width: 3,
    backgroundColor: '#FFFFFF',
    borderRadius: 1.5,
  },
  soundBarShort: { height: 6 },
  soundBarMed: { height: 10 },
  soundBarTall: { height: 14 },
  micDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
});
