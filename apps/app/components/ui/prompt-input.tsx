import { cn } from "@/lib/utils";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { View, Pressable, type TextInput as RNTextInput, KeyboardAvoidingView, Platform, Modal } from "react-native";
import { ChatTextInput } from "./chat-text-input";
import { Maximize2 } from "lucide-react-native";
import { PortalHost } from "@rn-primitives/portal";

type PromptInputContextType = {
  isLoading: boolean;
  value: string;
  setValue: (value: string) => void;
  maxHeight: number;
  onSubmit?: () => void;
  disabled?: boolean;
  textareaRef: React.RefObject<RNTextInput | null>;
  currentHeight: number;
  setCurrentHeight: (height: number) => void;
  isFullscreen: boolean;
  onImagePaste?: (files: File[]) => void;
};

// Export for use in other components
export function useIsFullscreen() {
  const context = useContext(PromptInputContext);
  return context.isFullscreen;
}

const PromptInputContext = createContext<PromptInputContextType>({
  isLoading: false,
  value: "",
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
  textareaRef: React.createRef<RNTextInput>(),
  currentHeight: 44,
  setCurrentHeight: () => {},
  isFullscreen: false,
});

function usePromptInput() {
  return useContext(PromptInputContext);
}

export type PromptInputProps = {
  isLoading?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  maxHeight?: number;
  onSubmit?: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onImagePaste?: (files: File[]) => void;
} & React.ComponentProps<typeof View>;

function PromptInput({
  className,
  isLoading = false,
  maxHeight = 240,
  value,
  onValueChange,
  onSubmit,
  children,
  disabled = false,
  onImagePaste,
  ...props
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || "");
  const [currentHeight, setCurrentHeight] = useState(44);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const textareaRef = useRef<RNTextInput>(null);

  const handleChange = (newValue: string) => {
    setInternalValue(newValue);
    onValueChange?.(newValue);
  };

  const handleSubmit = () => {
    onSubmit?.();
    // Close fullscreen after submit
    if (showFullscreen) {
      setShowFullscreen(false);
    }
  };

  // Reset height when exiting fullscreen
  useEffect(() => {
    if (!showFullscreen) {
      setCurrentHeight(44);
    }
  }, [showFullscreen]);

  const showExpandIcon = currentHeight > 100;

  return (
    <PromptInputContext.Provider
      value={{
        isLoading,
        value: value ?? internalValue,
        setValue: onValueChange ?? handleChange,
        maxHeight,
        onSubmit: handleSubmit,
        disabled,
        textareaRef,
        currentHeight,
        setCurrentHeight,
        isFullscreen: showFullscreen,
        onImagePaste,
      }}
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <Pressable
          onPress={() => {
            if (!disabled) textareaRef.current?.focus();
          }}
          disabled={disabled}
        >
          <View
            className={cn(
              "rounded-[24px] border border-border bg-background px-3 py-1 relative",
              disabled && "opacity-60",
              className
            )}
            {...props}
          >
            {/* Expand to fullscreen icon */}
            {showExpandIcon && !disabled && (
              <Pressable
                onPress={() => setShowFullscreen(true)}
                className="absolute top-2 right-2 z-10 bg-background rounded-full p-1.5 border border-border active:opacity-70"
              >
                <Maximize2 size={16} className="text-muted-foreground" />
              </Pressable>
            )}
            {children}
          </View>
        </Pressable>
      </KeyboardAvoidingView>

      {/* Fullscreen Editor Modal */}
      <Modal
        visible={showFullscreen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowFullscreen(false)}
        statusBarTranslucent
      >
        <View className="flex-1 bg-background" accessible={false} importantForAccessibility="no-hide-descendants">
          {/* Top right - Minimize icon */}
          <Pressable
            onPress={() => setShowFullscreen(false)}
            className="absolute top-4 right-4 z-50 p-2 active:opacity-70 bg-background/80 rounded-full"
            accessibilityRole="button"
            accessibilityLabel="Close fullscreen"
          >
            <Maximize2 size={20} className="text-foreground" />
          </Pressable>

          {/* Fullscreen prompt input - textarea fills entire screen */}
          <View className="flex-1">
            {children}
          </View>
        </View>

        {/* Portal host for dropdowns inside modal - positioned outside main view for proper layering */}
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100000 }} pointerEvents="box-none">
          <PortalHost name="fullscreen-modal" />
        </View>
      </Modal>
    </PromptInputContext.Provider>
  );
}

export type PromptInputTextareaProps = {
  placeholder?: string;
  className?: string;
} & React.ComponentProps<typeof ChatTextInput>;

function PromptInputTextarea({
  className,
  placeholder,
  style,
  ...props
}: PromptInputTextareaProps) {
  const { value, setValue, onSubmit, disabled, textareaRef, setCurrentHeight, isFullscreen, maxHeight, onImagePaste } =
    usePromptInput();

  const textInput = (
    <ChatTextInput
      ref={textareaRef}
      value={value}
      onChangeText={setValue}
      onSubmitEditing={onSubmit}
      onEnterPress={onSubmit}
      onHeightChange={setCurrentHeight}
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

export type PromptInputActionsProps = React.ComponentProps<typeof View>;

function PromptInputActions({
  children,
  className,
  ...props
}: PromptInputActionsProps) {
  const { isFullscreen } = usePromptInput();

  return (
    <View
      className={cn(
        "flex-row items-center gap-2",
        isFullscreen && "absolute bottom-4 left-4 right-4 max-w-2xl mx-auto rounded-full border border-border bg-background px-4 py-3 z-[10001]",
        className
      )}
      {...props}
    >
      {children}
    </View>
  );
}

export { PromptInput, PromptInputTextarea, PromptInputActions, usePromptInput };
