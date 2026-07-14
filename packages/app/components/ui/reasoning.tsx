import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { AliaMarkdown } from '@alia.onl/sdk';
import { withAlpha } from "@oxyhq/bloom/theme";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Brain, ChevronDown, ChevronRight } from "lucide-react-native";
import { cn } from "@/lib/utils";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
  cancelAnimation,
} from "react-native-reanimated";

// Context for sharing state between Reasoning components
type ReasoningContextType = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
};

const ReasoningContext = createContext<ReasoningContextType | null>(null);

/**
 * Hook to access the reasoning context from child components.
 */
export function useReasoning() {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("useReasoning must be used within a Reasoning component");
  }
  return context;
}

// Props types
export type ReasoningProps = {
  /** Whether the reasoning is currently streaming (auto-opens and closes the panel). */
  isStreaming?: boolean;
  /** Controlled open state. */
  open?: boolean;
  /** Default open state when uncontrolled. */
  defaultOpen?: boolean;
  /** Callback when open state changes. */
  onOpenChange?: (open: boolean) => void;
  /** Duration in seconds to display (can be controlled externally). */
  duration?: number;
  children: React.ReactNode;
  className?: string;
};

export type ReasoningTriggerProps = {
  /** Optional function to customize the thinking message. */
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => React.ReactNode;
  /** When provided, pressing the trigger calls this instead of toggling the collapsible. */
  onPress?: () => void;
  className?: string;
};

export type ReasoningContentProps = {
  /** The reasoning text to display (rendered via CustomMarkdown). */
  children: string;
  className?: string;
};

/**
 * Reasoning component that displays AI reasoning content.
 * Automatically opens during streaming and closes when finished.
 */
export function Reasoning({
  isStreaming = false,
  open,
  defaultOpen = true,
  onOpenChange,
  duration: externalDuration,
  children,
  className,
}: ReasoningProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [duration, setDuration] = useState<number | undefined>(externalDuration);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Use controlled or internal state
  const isOpen = open ?? internalOpen;
  const handleOpenChange = (newOpen: boolean) => {
    setInternalOpen(newOpen);
    onOpenChange?.(newOpen);
  };

  // Auto-open when streaming starts, track duration, and close when finished
  useEffect(() => {
    if (isStreaming) {
      // Open panel when streaming starts
      handleOpenChange(true);

      // Start duration timer
      startTimeRef.current = Date.now();
      intervalRef.current = setInterval(() => {
        if (startTimeRef.current) {
          const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
          setDuration(elapsed);
        }
      }, 1000);
    } else {
      // Clear interval when streaming stops
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      // Close panel after streaming ends (with a small delay for UX)
      if (startTimeRef.current !== null) {
        const timeoutId = setTimeout(() => {
          handleOpenChange(false);
        }, 500);
        return () => clearTimeout(timeoutId);
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isStreaming]);

  // Use external duration if provided
  useEffect(() => {
    if (externalDuration !== undefined) {
      setDuration(externalDuration);
    }
  }, [externalDuration]);

  return (
    <ReasoningContext.Provider
      value={{
        isStreaming,
        isOpen,
        setIsOpen: handleOpenChange,
        duration,
      }}
    >
      <Collapsible
        open={isOpen}
        onOpenChange={handleOpenChange}
        className={cn("w-full", className)}
      >
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  );
}

/**
 * Trigger component for the Reasoning collapsible.
 * Displays the thinking status with streaming indicator.
 */
export function ReasoningTrigger({
  getThinkingMessage,
  onPress,
  className,
}: ReasoningTriggerProps) {
  const { isStreaming, isOpen, duration } = useReasoning();

  // Pulsing animation for streaming indicator
  const pulseOpacity = useSharedValue(1);

  useEffect(() => {
    if (isStreaming) {
      pulseOpacity.value = withRepeat(
        withSequence(
          withTiming(0.4, { duration: 800 }),
          withTiming(1, { duration: 800 })
        ),
        -1, // Infinite repeat
        false
      );
    } else {
      cancelAnimation(pulseOpacity);
      pulseOpacity.value = 1;
    }
  }, [isStreaming]);

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: pulseOpacity.value,
  }));

  // Default thinking message
  const defaultThinkingMessage = (streaming: boolean, dur?: number) => {
    if (streaming) {
      return dur ? `Thinking for ${dur}s...` : "Thinking...";
    }
    return dur ? `Thought for ${dur} seconds` : "Reasoning";
  };

  const message = getThinkingMessage
    ? getThinkingMessage(isStreaming, duration)
    : defaultThinkingMessage(isStreaming, duration);

  const triggerContent = (
    <Pressable
      onPress={onPress}
      className={cn(
        "flex-row items-center gap-2 py-2 px-3 rounded-lg",
        "active:opacity-70",
        className
      )}
    >
      <Animated.View style={isStreaming ? pulseStyle : undefined}>
        <Brain size={16} color="#a855f7" />
      </Animated.View>
      <Text
        className="text-sm font-medium flex-1"
        style={{ color: "#a855f7" }}
      >
        {message}
      </Text>
      {onPress ? (
        <ChevronRight size={16} color="#a855f7" />
      ) : (
        <View
          style={{
            transform: [{ rotate: isOpen ? "180deg" : "0deg" }],
          }}
        >
          <ChevronDown size={16} color="#a855f7" />
        </View>
      )}
    </Pressable>
  );

  // When onPress is provided, render as a plain Pressable (opens panel)
  // Otherwise, wrap in CollapsibleTrigger for inline expand/collapse
  if (onPress) {
    return triggerContent;
  }

  return (
    <CollapsibleTrigger asChild>
      {triggerContent}
    </CollapsibleTrigger>
  );
}

/**
 * Content component for the Reasoning collapsible.
 * Renders the reasoning text using CustomMarkdown.
 */
export function ReasoningContent({ children, className }: ReasoningContentProps) {
  const { isStreaming } = useReasoning();
  const { colors } = useColorScheme();

  const aliaColors = useMemo(() => ({
    text: colors.foreground,
    border: colors.border,
    muted: colors.muted,
    mutedForeground: colors.mutedForeground,
    primary: colors.primary,
  }), [colors.foreground, colors.border, colors.muted, colors.mutedForeground, colors.primary]);

  return (
    <CollapsibleContent>
      <View
        className={cn(
          "px-3 pb-3 pt-1",
          className
        )}
      >
        <View
          className="rounded-lg p-3"
          style={{
            backgroundColor: withAlpha("#a855f7", 0.06),
            borderColor: withAlpha("#a855f7", 0.19),
            borderWidth: 1,
          }}
        >
          <View style={{ opacity: isStreaming ? 0.8 : 1 }}>
            <AliaMarkdown content={children} colors={aliaColors} />
          </View>
        </View>
      </View>
    </CollapsibleContent>
  );
}
