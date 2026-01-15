import * as React from "react";
import {
  TextInput,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { cn } from "@/lib/utils";

type ChatTextInputProps = React.ComponentPropsWithoutRef<typeof TextInput> & {
  noFocus?: boolean;
  onEnterPress?: () => void;
};

const ChatTextInput = React.forwardRef<TextInput, ChatTextInputProps>(
  ({ className, noFocus = false, onEnterPress, onKeyPress, ...props }, ref) => {
    const handleKeyPress = (
      e: NativeSyntheticEvent<TextInputKeyPressEventData>
    ) => {
      // Call the original onKeyPress if provided
      onKeyPress?.(e);

      // Handle Enter key press
      if (e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
        e.preventDefault();
        onEnterPress?.();
      }
    };

    return (
      <TextInput
        ref={ref}
        className={cn(
          "native:h-11 native:text-md native:leading-[1.25] h-9 rounded-xl border border-input bg-background px-3.5 text-base text-foreground file:border-0 file:bg-transparent file:font-medium placeholder:text-muted-foreground web:flex web:w-full web:py-2 lg:text-sm",
          "web:ring-offset-background web:focus-visible:outline-none web:focus-visible:ring-2 web:focus-visible:ring-ring web:focus-visible:ring-offset-2",
          noFocus && "web:focus-visible:ring-0 web:focus-visible:ring-offset-0",
          props.editable === false && "opacity-50 web:cursor-not-allowed",
          className
        )}
        placeholderClassName={cn("text-muted-foreground", props.placeholderClassName)}
        onKeyPress={handleKeyPress}
        {...props}
      />
    );
  }
);

ChatTextInput.displayName = "ChatTextInput";

export { ChatTextInput };
