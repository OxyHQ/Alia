import React from "react";
import { ArrowUp, Square } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePromptInput } from "./context";

/** Hoisted: one object for the life of the module rather than one per render. */
const STOP_ENABLED = { disabled: false } as const;

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
  const { onSubmit, value, attachments, disabled } = usePromptInput();
  const hasContent = value.trim() || attachments.length > 0;

  if (isLoading && onStop) {
    /*
     * Live for the whole of a stream, and says so. The lock every other
     * control takes while an answer streams is exactly what this one must
     * not: its job is to end that stream. `disabled={false}` and the explicit
     * `accessibilityState` are stated rather than left to the default so the
     * control reports itself enabled even if a wrapper's state changes again.
     */
    return (
      <Button
        size="icon"
        onPress={onStop}
        disabled={false}
        accessibilityRole="button"
        accessibilityLabel="Stop generating"
        accessibilityState={STOP_ENABLED}
        className={cn("h-9 w-9 rounded-full items-center justify-center", className)}
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
      // Nothing to send, a closed composer, or a turn already in flight
      // (`isLoading` without an `onStop` to offer instead).
      disabled={!hasContent || disabled || isLoading}
      accessibilityRole="button"
      accessibilityLabel="Send prompt"
      className={cn("h-9 w-9 rounded-full items-center justify-center", className)}
    >
      <ArrowUp size={18} color="white" />
    </Button>
  );
}
