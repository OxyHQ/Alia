import React, { useEffect } from "react";
import { Pressable, ActivityIndicator } from "react-native";
import { MicOff } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/lib/hooks/use-translation";
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
 *
 * Bloom models this control as `listening` / `onListeningChange` on both
 * composers and swaps the mic for equalizer bars while it is true. That is a
 * presentation flag with no recorder behind it — the right division for a UI
 * kit, and the wrong one here: the state this button reports is three-way
 * (idle, recording, transcribing), the transcription can fail and has to say
 * so, and the audio has to reach somewhere. So the flag stays ours.
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
  const { t } = useTranslation();

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
      /*
       * "Dictate", never "Talk to Alia". Bloom calls the same control
       * `ComposerPanelLabels.voice` and swaps its mic for equalizer bars while
       * `listening`, which is the same idea: this button turns speech into
       * TEXT IN THIS FIELD, which the person then reads, edits and sends. It is
       * not the voice session — that is `emptyAction` on the send slot, and
       * conflating the two would make one control do two irreversible things.
       */
      accessibilityLabel={t(stt.isRecording ? "composer.voiceStop" : "composer.voice")}
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
