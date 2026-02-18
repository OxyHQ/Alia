import * as React from "react";
import {
  TextInput,
  Platform,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
  type NativeSyntheticEvent as RNSyntheticEvent,
  type TextInputContentSizeChangeEventData,
} from "react-native";
import { cn } from "@/lib/utils";

type ChatTextInputProps = React.ComponentPropsWithoutRef<typeof TextInput> & {
  noFocus?: boolean;
  onEnterPress?: () => void;
  onCompletionKey?: (key: string) => boolean;
  maxHeight?: number;
  minHeight?: number;
  onHeightChange?: (height: number) => void;
  disableEnterToSubmit?: boolean;
  disableAutoHeight?: boolean;
  onImagePaste?: (files: File[]) => void;
  fillContainer?: boolean;
};

const ChatTextInput = React.forwardRef<TextInput, ChatTextInputProps>(
  ({
    className,
    noFocus = false,
    onEnterPress,
    onCompletionKey,
    onKeyPress,
    maxHeight = 200,
    minHeight = 44,
    onContentSizeChange,
    onHeightChange,
    style,
    disableEnterToSubmit = false,
    disableAutoHeight = false,
    onImagePaste,
    fillContainer = false,
    ...props
  }, ref) => {
    const inputRef = React.useRef<TextInput>(null);
    const wrapperRef = React.useRef<View>(null);

    // Combine refs
    React.useImperativeHandle(ref, () => inputRef.current as TextInput);

    // Attach paste event listener (web only) using document-level listener
    React.useEffect(() => {
      if (Platform.OS !== 'web' || !onImagePaste) return;

      const handlePaste = (e: Event) => {
        const clipboardEvent = e as ClipboardEvent;

        // Check if our input is focused
        // @ts-ignore - web-specific API
        const activeElement = document.activeElement;
        // @ts-ignore - web-specific API
        const wrapper = wrapperRef.current;

        // Only handle paste if our input is active
        // @ts-ignore - web-specific API
        const isContained = wrapper && wrapper.contains(activeElement);

        if (!isContained) return;

        const items = clipboardEvent.clipboardData?.items;
        if (!items) return;

        const imageFiles: File[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.indexOf('image') !== -1) {
            const file = item.getAsFile();
            if (file) {
              imageFiles.push(file);
            }
          }
        }

        if (imageFiles.length > 0) {
          clipboardEvent.preventDefault();
          onImagePaste(imageFiles);
        }
      };

      // @ts-ignore - web-specific API
      document.addEventListener('paste', handlePaste);

      return () => {
        // @ts-ignore - web-specific API
        document.removeEventListener('paste', handlePaste);
      };
    }, [onImagePaste]);

    const handleKeyPress = (
      e: NativeSyntheticEvent<TextInputKeyPressEventData>
    ) => {
      // Call the original onKeyPress if provided
      onKeyPress?.(e);

      const key = e.nativeEvent.key;

      // Arrow keys and Enter — autocomplete navigation
      if (onCompletionKey && (key === "ArrowUp" || key === "ArrowDown" || key === "Enter" || key === "Escape")) {
        if (onCompletionKey(key)) {
          e.preventDefault();
          return;
        }
      }

      // Handle Enter key press (without Shift on web)
      if (key === "Enter" && !disableEnterToSubmit) {
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
      onContentSizeChange?.(e);
    };

    return (
      <View
        ref={wrapperRef}
        style={{ width: '100%', ...(fillContainer && { flex: 1 }) }}
        onLayout={(e) => onHeightChange?.(e.nativeEvent.layout.height)}
      >
        <TextInput
          ref={inputRef}
          className={cn(
            "native:text-md native:leading-[1.25] rounded-xl border border-input bg-background px-3.5 text-base text-foreground file:border-0 file:bg-transparent file:font-medium placeholder:text-muted-foreground web:flex web:w-full web:py-2 lg:text-sm",
            "web:ring-offset-background web:focus-visible:outline-none web:focus-visible:ring-2 web:focus-visible:ring-ring web:focus-visible:ring-offset-2",
            !fillContainer && !props.multiline && "h-9",
            fillContainer && "h-full",
            noFocus && "web:focus-visible:ring-0 web:focus-visible:ring-offset-0",
            props.editable === false && "opacity-50 web:cursor-not-allowed",
            className
          )}
          placeholderClassName={cn("text-muted-foreground", props.placeholderClassName)}
          onKeyPress={handleKeyPress}
          onContentSizeChange={handleContentSizeChange}
          scrollEnabled={fillContainer || props.multiline}
          style={[
            style,
            !fillContainer && props.multiline && !disableAutoHeight && {
              minHeight,
              maxHeight,
              overflow: 'auto',
              ...(Platform.OS === 'web' ? { fieldSizing: 'content' } : {}),
            },
            fillContainer && { flex: 1, height: '100%' },
          ]}
          {...props}
        />
      </View>
    );
  }
);

ChatTextInput.displayName = "ChatTextInput";

export { ChatTextInput };
