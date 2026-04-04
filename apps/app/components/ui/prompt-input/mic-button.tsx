import React from "react";
import { Pressable } from "react-native";
import { Mic } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { toast } from "@/components/sonner";

export type PromptInputMicButtonProps = {
  className?: string;
};

export function PromptInputMicButton({ className }: PromptInputMicButtonProps) {
  const handlePress = () => {
    toast.info("Speech-to-text is not available yet.");
  };

  return (
    <Pressable
      onPress={handlePress}
      className={cn(
        "h-8 w-8 rounded-full items-center justify-center active:opacity-70",
        className
      )}
    >
      <Mic size={16} className="text-muted-foreground" />
    </Pressable>
  );
}
