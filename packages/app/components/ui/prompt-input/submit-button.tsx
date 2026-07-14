import React from "react";
import { ArrowUp, Square } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePromptInput } from "./context";

export type PromptInputSubmitButtonProps = {
  isLoading?: boolean;
  onStop?: () => void;
  emptyAction?: React.ReactNode;
  className?: string;
};

export function PromptInputSubmitButton({
  isLoading,
  onStop,
  emptyAction,
  className,
}: PromptInputSubmitButtonProps) {
  const { onSubmit, value, attachments } = usePromptInput();
  const hasContent = value.trim() || attachments.length > 0;

  if (isLoading && onStop) {
    return (
      <Button
        size="icon"
        onPress={onStop}
        className={cn("h-10 w-10 rounded-full items-center justify-center", className)}
      >
        <Square size={14} color="white" className="fill-current" />
      </Button>
    );
  }

  if (!hasContent && emptyAction) {
    return <>{emptyAction}</>;
  }

  return (
    <Button
      size="icon"
      onPress={onSubmit}
      disabled={!hasContent}
      className={cn("h-10 w-10 rounded-full items-center justify-center", className)}
    >
      <ArrowUp size={18} color="white" />
    </Button>
  );
}
