import React from "react";
import { StyleSheet, View } from "react-native";
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
    handleCompletionKey,
  } = usePromptInput();

  const inputStyle = React.useMemo(
    () => [style, styles.borderless, isFullscreen && styles.fullscreen],
    [isFullscreen, style],
  );

  const textInput = (
    <ChatTextInput
      ref={textareaRef}
      value={value}
      onChangeText={setValue}
      onSubmitEditing={onSubmit}
      onEnterPress={onSubmit}
      onHeightChange={setCurrentHeight}
      onCompletionKey={handleCompletionKey ?? undefined}
      disableEnterToSubmit={isFullscreen}
      disableAutoHeight={isFullscreen}
      maxHeight={isFullscreen ? 10000 : maxHeight}
      onImagePaste={onImagePaste}
      fillContainer={isFullscreen}
      unstyled
      className={cn(
        "w-full border-0 bg-transparent text-foreground web:shadow-none",
        isFullscreen ? "px-4 pt-4" : "min-h-[44px] py-3",
        className
      )}
      style={inputStyle}
      underlineColorAndroid="transparent"
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

const styles = StyleSheet.create({
  borderless: {
    borderWidth: 0,
  },
  fullscreen: {
    paddingBottom: 100,
  },
});
