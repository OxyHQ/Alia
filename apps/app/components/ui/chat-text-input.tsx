import * as React from "react";
import {
  TextInput,
  Platform,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
  type NativeSyntheticEvent as RNSyntheticEvent,
  type TextInputContentSizeChangeEventData,
} from "react-native";
import { MarkdownTextInput } from "react-native-live-markdown";
import { cn } from "@/lib/utils";

type ChatTextInputProps = React.ComponentPropsWithoutRef<typeof TextInput> & {
  noFocus?: boolean;
  onEnterPress?: () => void;
  maxHeight?: number;
  minHeight?: number;
  onHeightChange?: (height: number) => void;
  disableEnterToSubmit?: boolean;
};

const ChatTextInput = React.forwardRef<TextInput, ChatTextInputProps>(
  ({
    className,
    noFocus = false,
    onEnterPress,
    onKeyPress,
    maxHeight = 200,
    minHeight = 44,
    onContentSizeChange,
    onHeightChange,
    style,
    disableEnterToSubmit = false,
    ...props
  }, ref) => {
    const [height, setHeight] = React.useState(minHeight);

    const handleKeyPress = (
      e: NativeSyntheticEvent<TextInputKeyPressEventData>
    ) => {
      // Call the original onKeyPress if provided
      onKeyPress?.(e);

      // Handle Enter key press (without Shift on web)
      if (e.nativeEvent.key === "Enter" && !disableEnterToSubmit) {
        // @ts-ignore - shiftKey exists on web
        if (Platform.OS !== 'web' || !e.nativeEvent.shiftKey) {
          e.preventDefault();
          onEnterPress?.();
        }
      }
    };

    const handleContentSizeChange = (
      e: RNSyntheticEvent<TextInputContentSizeChangeEventData>
    ) => {
      // Call original handler if provided
      onContentSizeChange?.(e);

      // Auto-resize based on content
      const newHeight = e.nativeEvent.contentSize.height;
      const calculatedHeight = Math.min(Math.max(newHeight, minHeight), maxHeight);
      setHeight(calculatedHeight);
      onHeightChange?.(calculatedHeight);
    };

    return (
      <TextInput
        ref={ref}
        className={cn(
          "native:text-md native:leading-[1.25] h-9 rounded-xl border border-input bg-background px-3.5 text-base text-foreground file:border-0 file:bg-transparent file:font-medium placeholder:text-muted-foreground web:flex web:w-full web:py-2 lg:text-sm",
          "web:ring-offset-background web:focus-visible:outline-none web:focus-visible:ring-2 web:focus-visible:ring-ring web:focus-visible:ring-offset-2",
          noFocus && "web:focus-visible:ring-0 web:focus-visible:ring-offset-0",
          props.editable === false && "opacity-50 web:cursor-not-allowed",
          className
        )}
        placeholderClassName={cn("text-muted-foreground", props.placeholderClassName)}
        onKeyPress={handleKeyPress}
        onContentSizeChange={handleContentSizeChange}
        style={[
          style,
          props.multiline && { height },
        ]}
        {...props}
      />
    );
  }
);

ChatTextInput.displayName = "ChatTextInput";

export { ChatTextInput };
