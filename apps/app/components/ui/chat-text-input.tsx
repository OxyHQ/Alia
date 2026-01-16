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
    const [height, setHeight] = React.useState(minHeight);
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

    // Reset height when minHeight changes (e.g., when switching fullscreen modes)
    React.useEffect(() => {
      setHeight(minHeight);
    }, [minHeight]);

    // Reset height when switching from fullscreen to normal (when auto-height is re-enabled)
    React.useEffect(() => {
      if (!disableAutoHeight) {
        setHeight(minHeight);
      }
    }, [disableAutoHeight, minHeight]);

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
      <View ref={wrapperRef} style={{ width: '100%', ...(fillContainer && { flex: 1 }) }}>
        <TextInput
          ref={inputRef}
          className={cn(
            "native:text-md native:leading-[1.25] rounded-xl border border-input bg-background px-3.5 text-base text-foreground file:border-0 file:bg-transparent file:font-medium placeholder:text-muted-foreground web:flex web:w-full web:py-2 lg:text-sm",
            "web:ring-offset-background web:focus-visible:outline-none web:focus-visible:ring-2 web:focus-visible:ring-ring web:focus-visible:ring-offset-2",
            !fillContainer && "h-9",
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
            !fillContainer && props.multiline && !disableAutoHeight && { height },
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
