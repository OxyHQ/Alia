import React, { useEffect, useState } from "react";
import { View, Pressable } from "react-native";
import { X, Square, ArrowUp } from "lucide-react-native";
import { useSTTStore } from "@alia.onl/sdk";

import { cn } from "@/lib/utils";
import { useColorScheme } from "@/lib/useColorScheme";

/**
 * The composer while it is listening.
 *
 * Everything that belongs to typing — the text field, the add menu, the model
 * and effort pills — is gone, because none of it applies to a voice that is
 * mid-sentence. What is left is the three things a person can do about a
 * recording in progress: throw it away, stop it, or send it.
 *
 * It replaces the composer's content rather than reflowing inside it. The
 * typing layout is a CSS grid on web and absolutely anchored controls on
 * native; threading a fourth state through both would make every future change
 * to either answer for a mode it has nothing to do with.
 */

/** How many bars the trace holds. Enough to read as speech, cheap to render. */
const TRACE_LENGTH = 48;

/** The quietest a bar gets, as a fraction of the track. A flat line reads as a
 * dead microphone; a floor reads as silence. */
const SILENCE_FLOOR = 0.08;

export type PromptInputDictationBarProps = {
  onCancel: () => void;
  onStop: () => void;
  onSend: () => void;
  /** True once recording has stopped and the audio is being transcribed. */
  isTranscribing?: boolean;
};

/**
 * The moving trace of what the microphone is hearing.
 *
 * `metering` is already normalised to 0..1 by the SDK and published on a store
 * that updates about ten times a second, so this only has to remember the last
 * few seconds of it. The history lives in React state rather than a ref because
 * the value it is derived from is external and mutable — a ref read from a
 * memoized position is the stale-read this codebase has been bitten by.
 */
function DictationTrace({ active }: { active: boolean }) {
  const metering = useSTTStore((state) => state.metering);
  const [trace, setTrace] = useState<number[]>(() => Array(TRACE_LENGTH).fill(0));

  useEffect(() => {
    if (!active) return;
    setTrace((previous) => [...previous.slice(1), metering]);
  }, [metering, active]);

  return (
    <View className="flex-1 flex-row items-center justify-center gap-[2px] h-9 min-w-0 overflow-hidden">
      {trace.map((level, index) => (
        <View
          key={index}
          className="w-[3px] rounded-full bg-muted-foreground"
          // A height per bar is a computed value, not a style choice: NativeWind
          // has no class for "this many percent of a track", and the number
          // changes ten times a second.
          style={{ height: `${Math.round((SILENCE_FLOOR + level * (1 - SILENCE_FLOOR)) * 100)}%` }}
        />
      ))}
    </View>
  );
}

export function PromptInputDictationBar({
  onCancel,
  onStop,
  onSend,
  isTranscribing = false,
}: PromptInputDictationBarProps) {
  const { colors } = useColorScheme();

  return (
    <View className="flex-row items-center gap-2 px-2 min-h-[52px] py-1">
      <Pressable
        onPress={onCancel}
        accessibilityLabel="Discard dictation"
        className="h-9 w-9 rounded-full items-center justify-center border border-border web:hover:bg-muted active:bg-muted"
      >
        <X size={18} color={colors.mutedForeground} />
      </Pressable>

      <DictationTrace active={!isTranscribing} />

      <Pressable
        onPress={onStop}
        disabled={isTranscribing}
        accessibilityLabel="Stop dictation"
        className={cn(
          "h-9 w-9 rounded-full items-center justify-center border border-border web:hover:bg-muted active:bg-muted",
          isTranscribing && "opacity-50"
        )}
      >
        <Square size={14} color={colors.mutedForeground} className="fill-current" />
      </Pressable>

      <Pressable
        onPress={onSend}
        disabled={isTranscribing}
        accessibilityLabel="Send dictated message"
        className={cn(
          "h-9 w-9 rounded-full items-center justify-center bg-primary",
          isTranscribing && "opacity-50"
        )}
      >
        <ArrowUp size={18} color={colors.primaryForeground} />
      </Pressable>
    </View>
  );
}
