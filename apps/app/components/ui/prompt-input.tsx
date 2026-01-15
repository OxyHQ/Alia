import { cn } from "@/lib/utils";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { View, Pressable, type TextInput as RNTextInput, KeyboardAvoidingView, Platform } from "react-native";
import { ChatTextInput } from "./chat-text-input";

type PromptInputContextType = {
  isLoading: boolean;
  value: string;
  setValue: (value: string) => void;
  maxHeight: number;
  onSubmit?: () => void;
  disabled?: boolean;
  textareaRef: React.RefObject<RNTextInput | null>;
};

const PromptInputContext = createContext<PromptInputContextType>({
  isLoading: false,
  value: "",
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
  textareaRef: React.createRef<RNTextInput>(),
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
  const textareaRef = useRef<RNTextInput>(null);

  const handleChange = (newValue: string) => {
    setInternalValue(newValue);
    onValueChange?.(newValue);
  };

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
              "rounded-[24px] border border-border bg-background px-3 py-1",
              disabled && "opacity-60",
              className
            )}
            {...props}
          >
            {children}
          </View>
        </Pressable>
      </KeyboardAvoidingView>
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
  const { value, setValue, onSubmit, disabled, textareaRef } =
    usePromptInput();

  return (
    <ChatTextInput
      ref={textareaRef}
      value={value}
      onChangeText={setValue}
      onSubmitEditing={onSubmit}
      onEnterPress={onSubmit}
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
