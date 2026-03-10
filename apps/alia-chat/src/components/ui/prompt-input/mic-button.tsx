import React, { useEffect } from "react";
import { Pressable, ActivityIndicator } from "react-native";
import { Mic, MicOff } from "lucide-react-native";
import { cn } from "../../../lib/utils";
import { useSpeechToText } from "../../../hooks/useSpeechToText";
import { usePromptInput } from "./context";

export type PromptInputMicButtonProps = {
  className?: string;
  apiUrl?: string;
};

export function PromptInputMicButton({ className, apiUrl }: PromptInputMicButtonProps) {
  const { value, setValue, onError } = usePromptInput();
  const stt = useSpeechToText({ apiUrl });

  useEffect(() => {
    if (stt.error) {
      if (onError) onError(stt.error);
      else console.warn('[PromptInput] STT error:', stt.error);
    }
  }, [stt.error, onError]);

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
        <ActivityIndicator size="small" color="#6366f1" />
      ) : stt.isRecording ? (
        <MicOff size={16} color="#ef4444" />
      ) : (
        <Mic size={16} className="text-muted-foreground" />
      )}
    </Pressable>
  );
}
