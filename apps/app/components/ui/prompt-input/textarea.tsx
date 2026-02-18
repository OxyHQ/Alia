import React from "react";
import { View } from "react-native";
import { cn } from "@/lib/utils";
import { ChatTextInput } from "../chat-text-input";
import { usePromptInput } from "./context";

export type PromptInputTextareaProps = {
  placeholder?: string;
  className?: string;
} & React.ComponentProps<typeof ChatTextInput>;

export function PromptInputTextarea({
  className,
  placeholder,
  style,
  ...props
}: PromptInputTextareaProps) {
  const {
    value,
    setValue,
    onSubmit,
    disabled,
    textareaRef,
    setCurrentHeight,
    isFullscreen,
    maxHeight,
    onImagePaste,
    acceptCompletion,
  } = usePromptInput();

  const textInput = (
    <ChatTextInput
      ref={textareaRef}
      value={value}
      onChangeText={setValue}
      onSubmitEditing={onSubmit}
      onEnterPress={onSubmit}
      onHeightChange={setCurrentHeight}
      onTabPress={acceptCompletion ? () => acceptCompletion() : undefined}
      disableEnterToSubmit={isFullscreen}
      disableAutoHeight={isFullscreen}
      maxHeight={isFullscreen ? 10000 : maxHeight}
      onImagePaste={onImagePaste}
      fillContainer={isFullscreen}
      className={cn(
        "w-full border-0 bg-transparent text-foreground shadow-none",
        isFullscreen ? "px-4 pt-4" : "min-h-[44px] py-3",
        className
      )}
      style={[style, isFullscreen && { paddingBottom: 100 }]}
      placeholder={placeholder}
      multiline
      editable={!disabled}
      noFocus={true}
      {...props}
    />
  );

  if (isFullscreen) {
    return <View style={{ flex: 1 }}>{textInput}</View>;
  }

  return textInput;
}
