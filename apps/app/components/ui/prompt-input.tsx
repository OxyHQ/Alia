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
import { Button } from "./button";
import { Text } from "./text";
import { Maximize2, X, ArrowUp } from "lucide-react-native";

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
};

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
  ...props
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || "");
  const [currentHeight, setCurrentHeight] = useState(44);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const textareaRef = useRef<RNTextInput>(null);
  const fullscreenTextareaRef = useRef<RNTextInput>(null);

  const handleChange = (newValue: string) => {
    setInternalValue(newValue);
    onValueChange?.(newValue);
  };

  const showExpandIcon = currentHeight > 100;

  return (
    <PromptInputContext.Provider
      value={{
        isLoading,
        value: value ?? internalValue,
        setValue: onValueChange ?? handleChange,
        maxHeight,
        onSubmit,
        disabled,
        textareaRef,
        currentHeight,
        setCurrentHeight,
        isFullscreen: showFullscreen,
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
      >
        <View className="flex-1 bg-background pt-16">
          {/* Top right - Minimize icon */}
          <Pressable
            onPress={() => setShowFullscreen(false)}
            className="absolute top-16 right-4 z-10 p-2 active:opacity-70"
          >
            <Maximize2 size={20} className="text-foreground" />
          </Pressable>

          {/* Fullscreen prompt input - clean, no border or rounded corners */}
          <View className="flex-1 flex-col justify-end px-4 pb-4">
            <View className="flex-1" />
            <View className="bg-background px-3 py-1">
              {children}
            </View>
          </View>
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
  ...props
}: PromptInputTextareaProps) {
  const { value, setValue, onSubmit, disabled, textareaRef, setCurrentHeight, isFullscreen } =
    usePromptInput();

  return (
    <ChatTextInput
      ref={textareaRef}
      value={value}
      onChangeText={setValue}
      onSubmitEditing={onSubmit}
      onEnterPress={onSubmit}
      onHeightChange={setCurrentHeight}
      disableEnterToSubmit={isFullscreen}
      className={cn(
        "min-h-[44px] w-full border-0 bg-transparent py-3 text-foreground shadow-none",
        className
      )}
      placeholder={placeholder}
      multiline
      editable={!disabled}
      noFocus={true}
      {...props}
    />
  );
}

export type PromptInputActionsProps = React.ComponentProps<typeof View>;

function PromptInputActions({
  children,
  className,
  ...props
}: PromptInputActionsProps) {
  return (
    <View className={cn("flex-row items-center gap-2", className)} {...props}>
      {children}
    </View>
  );
}

export { PromptInput, PromptInputTextarea, PromptInputActions };
