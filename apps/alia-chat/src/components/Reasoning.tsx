import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
  cancelAnimation,
} from 'react-native-reanimated';


// Context
type ReasoningContextType = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
};

const ReasoningContext = createContext<ReasoningContextType | null>(null);

function useReasoning() {
  const context = useContext(ReasoningContext);
  if (!context) throw new Error('useReasoning must be used within a Reasoning component');
  return context;
}

// Props
interface ReasoningProps {
  isStreaming?: boolean;
  defaultOpen?: boolean;
  duration?: number;
  children: React.ReactNode;
}

interface ReasoningTriggerProps {
  onPress?: () => void;
}

interface ReasoningContentProps {
  children: string;
}

// Reasoning wrapper — manages open/close state with auto-open during streaming
export function Reasoning({ isStreaming = false, defaultOpen = true, duration: externalDuration, children }: ReasoningProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [duration, setDuration] = useState<number | undefined>(externalDuration);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isStreaming) {
      setIsOpen(true);
      startTimeRef.current = Date.now();
      intervalRef.current = setInterval(() => {
        if (startTimeRef.current) {
          setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }
      }, 1000);
    } else {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (startTimeRef.current !== null) {
        const t = setTimeout(() => setIsOpen(false), 500);
        return () => clearTimeout(t);
      }
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isStreaming]);

  useEffect(() => { if (externalDuration !== undefined) setDuration(externalDuration); }, [externalDuration]);

  return (
    <ReasoningContext.Provider value={{ isStreaming, isOpen, setIsOpen, duration }}>
      <View>{children}</View>
    </ReasoningContext.Provider>
  );
}

// Trigger — shows "Thinking for Xs..." label with pulsing icon
export function ReasoningTrigger({ onPress }: ReasoningTriggerProps) {
  const { isStreaming, isOpen, setIsOpen, duration } = useReasoning();
  const pulseOpacity = useSharedValue(1);

  useEffect(() => {
    if (isStreaming) {
      pulseOpacity.value = withRepeat(withSequence(withTiming(0.4, { duration: 800 }), withTiming(1, { duration: 800 })), -1, false);
    } else {
      cancelAnimation(pulseOpacity);
      pulseOpacity.value = 1;
    }
  }, [isStreaming]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulseOpacity.value }));

  const message = isStreaming
    ? (duration ? `Thinking for ${duration}s...` : 'Thinking...')
    : (duration ? `Thought for ${duration} seconds` : 'Reasoning');

  const handlePress = onPress || (() => setIsOpen(!isOpen));

  return (
    <Pressable onPress={handlePress} style={styles.trigger}>
      <Animated.View style={isStreaming ? pulseStyle : undefined}>
        <Text style={{ color: '#a855f7', fontSize: 14 }}>{'\u2726'}</Text>
      </Animated.View>
      <Text style={[styles.triggerText, { color: '#a855f7' }]}>{message}</Text>
      <Text style={{ color: '#a855f7', fontSize: 14 }}>{onPress ? '\u203A' : (isOpen ? '\u25BE' : '\u25B8')}</Text>
    </Pressable>
  );
}

// Content — renders thinking text (collapsible)
export function ReasoningContent({ children }: ReasoningContentProps) {
  const { isOpen, isStreaming } = useReasoning();

  if (!isOpen) return null;

  // Lazy import AliaMarkdown to avoid circular dependency
  const { AliaMarkdown } = require('./Markdown');

  return (
    <View style={[styles.contentWrapper, { backgroundColor: '#a855f710', borderColor: '#a855f730' }]}>
      <View style={{ opacity: isStreaming ? 0.8 : 1 }}>
        <AliaMarkdown content={children} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  triggerText: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  contentWrapper: {
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    marginHorizontal: 12,
    marginBottom: 12,
  },
});
