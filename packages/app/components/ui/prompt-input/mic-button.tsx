import React, { useEffect } from "react";
import { Pressable, ActivityIndicator } from "react-native";
import { MicOff } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTheme } from "@oxy.so/bloom/theme";
import { toast } from "@oxy.so/bloom/toast";
import { usePromptInput } from "./context";
import { ComposerGlyph } from "./composer-glyph";

/**
 * The recorder is passed IN, not created here.
 *
 * `useSpeechToText` builds its own `useAudioRecorder`, so a second call is a
 * second recorder — and then the button that stops dictation is stopping
 * something other than the one that is listening. One instance lives in the
 * composer and both this and the dictation bar act on it.
 */
export type PromptInputMicButtonProps = {
  className?: string;
  stt: {
    isRecording: boolean;
    isTranscribing: boolean;
    error: string | null;
    startRecording: () => void;
    stopAndTranscribe: () => Promise<string | null>;
  };
};

export function PromptInputMicButton({ className, stt }: PromptInputMicButtonProps) {
  const { value, setValue, disabled, isLoading } = usePromptInput();
  const { colors } = useColorScheme();
  const { colors: themeColors } = useTheme();

  useEffect(() => {
    if (stt.error) toast.error(stt.error);
  }, [stt.error]);

  const handlePress = async () => {
    if (stt.isRecording) {
      const text = await stt.stopAndTranscribe();
      if (text) {
        setValue(value ? `${value} ${text}` : text);
      }
    } else if (!stt.isTranscribing) {
      stt.startRecording();
    }
  };

  return (
    <Pressable
      onPress={handlePress}
      // Dictation writes into the same draft typing does, so it is locked by
      // the same two things: a stream in progress and the usage limit.
      disabled={stt.isTranscribing || disabled || isLoading}
      accessibilityRole="button"
      accessibilityLabel={stt.isRecording ? "Stop recording" : "Dictate"}
      className={cn(
        "h-9 w-9 rounded-full items-center justify-center web:hover:bg-muted active:bg-muted",
        className
      )}
    >
      {stt.isTranscribing ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : stt.isRecording ? (
        <MicOff size={18} color={themeColors.error} />
      ) : (
        <ComposerGlyph name="microphone" size={20} color={colors.mutedForeground} />
      )}
    </Pressable>
  );
}
