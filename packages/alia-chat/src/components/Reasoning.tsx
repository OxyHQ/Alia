import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { AgentThinking } from '@oxy.so/bloom/agent-thinking';
import { Button } from '@oxy.so/bloom/button';
import { useLabels } from '../lib/labels';
import { RiArrowDownSLine, RiArrowRightSLine, RiSparklingLine } from '@oxy.so/bloom/icons';

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
export function Reasoning({
  isStreaming = false,
  defaultOpen = true,
  duration: externalDuration,
  children,
}: ReasoningProps) {
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
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (startTimeRef.current !== null) {
        const t = setTimeout(() => setIsOpen(false), 500);
        return () => clearTimeout(t);
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isStreaming]);

  useEffect(() => {
    if (externalDuration !== undefined) setDuration(externalDuration);
  }, [externalDuration]);

  return (
    <ReasoningContext.Provider value={{ isStreaming, isOpen, setIsOpen, duration }}>
      <View>{children}</View>
    </ReasoningContext.Provider>
  );
}

// Trigger — a live "Thinking" indicator while streaming, a disclosure button once done
export function ReasoningTrigger({ onPress }: ReasoningTriggerProps) {
  const { isStreaming, isOpen, setIsOpen, duration } = useReasoning();
  const labels = useLabels();
  const handlePress = onPress || (() => setIsOpen(!isOpen));

  if (isStreaming) {
    return (
      <Pressable onPress={handlePress} accessibilityRole="button" className="px-3 py-2">
        <AgentThinking variant="stars" showTimer />
      </Pressable>
    );
  }

  return (
    <Button
      tone="neutral"
      appearance="plain"
      size="sm"
      leadingIcon={RiSparklingLine}
      trailingIcon={onPress ? RiArrowRightSLine : isOpen ? RiArrowDownSLine : RiArrowRightSLine}
      onPress={handlePress}
    >
      {duration ? labels.thoughtFor(duration) : labels.reasoning}
    </Button>
  );
}

// Content — renders thinking text (collapsible)
export function ReasoningContent({ children }: ReasoningContentProps) {
  const { isOpen, isStreaming } = useReasoning();

  if (!isOpen) return null;

  // Lazy import AliaMarkdown to avoid circular dependency
  const { AliaMarkdown } = require('./Markdown');

  return (
    <View className="mx-3 mb-3 rounded-lg border border-border-secondary bg-background-secondary-default p-3">
      <View style={{ opacity: isStreaming ? 0.8 : 1 }}>
        <AliaMarkdown content={children} />
      </View>
    </View>
  );
}
