import React, { useEffect } from "react";
import { Pressable, ActivityIndicator } from "react-native";
import { Mic, MicOff } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSpeechToText } from "@/lib/hooks/use-speech-to-text";
import { toast } from "@/components/sonner";
import { usePromptInput } from "./context";

export type PromptInputMicButtonProps = {
  className?: string;
};

export function PromptInputMicButton({ className }: PromptInputMicButtonProps) {
  const { value, setValue } = usePromptInput();
  const { colors } = useColorScheme();
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
      className={cn(
        "h-8 w-8 rounded-full items-center justify-center active:opacity-70",
        className
      )}
    >
      {stt.isTranscribing ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : stt.isRecording ? (
        <MicOff size={16} color="#ef4444" />
      ) : (
        <Mic size={16} className="text-muted-foreground" />
      )}
    </Pressable>
  );
}
