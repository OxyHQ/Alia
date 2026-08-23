import React, { useEffect } from "react";
import { Pressable, ActivityIndicator } from "react-native";
import { MicOff } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTheme } from "@oxyhq/bloom/theme";
import { useSpeechToText } from "@/lib/hooks/use-speech-to-text";
import { toast } from "@oxyhq/bloom/toast";
import { usePromptInput } from "./context";
import { ComposerGlyph } from "./composer-glyph";

export type PromptInputMicButtonProps = {
  className?: string;
};

export function PromptInputMicButton({ className }: PromptInputMicButtonProps) {
  const { value, setValue } = usePromptInput();
  const { colors } = useColorScheme();
  const { colors: themeColors } = useTheme();
  const stt = useSpeechToText();

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
      disabled={stt.isTranscribing}
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
