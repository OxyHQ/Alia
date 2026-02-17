import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Pressable,
  type TextInput as RNTextInput,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Maximize2, Minimize2 } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { PromptInputContext, type Attachment } from "./context";
import { PromptInputTextarea } from "./textarea";
import { PromptInputActions } from "./actions";
import { PromptInputMicButton } from "./mic-button";
import { PromptInputAutocomplete } from "./autocomplete";
import { PromptInputAttachments } from "./attachments";
import { PromptInputSubmitButton } from "./submit-button";
import { PromptInputAddMenu } from "./add-menu";

export type PromptInputProps = {
  isLoading?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  maxHeight?: number;
  onSubmit?: () => void;
  children?: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onImagePaste?: (files: File[]) => void;
  // Simple mode props (when no children)
  placeholder?: string;
  autocomplete?: boolean;
  // Shows the add menu as a standalone button to the left of the input box
  leadingAddMenu?: boolean;
  // Custom left-side actions (replaces default add menu in the actions bar)
  actionsLeft?: React.ReactNode;
  // Submit button props
  onStop?: () => void;
  emptyAction?: React.ReactNode;
  // Controlled attachments (optional — uses internal state if omitted)
  attachments?: Attachment[];
  onAddAttachment?: (attachment: Attachment) => void;
  onRemoveAttachment?: (id: string) => void;
  onUpdateAttachment?: (id: string, updates: Partial<Attachment>) => void;
} & Omit<React.ComponentProps<typeof View>, "children">;

export function PromptInput({
  className,
  isLoading = false,
  maxHeight = 240,
  value,
  onValueChange,
  onSubmit,
  children,
  disabled = false,
  onImagePaste,
  placeholder,
  autocomplete = false,
  leadingAddMenu = false,
  actionsLeft,
  onStop,
  emptyAction,
  attachments: controlledAttachments,
  onAddAttachment,
  onRemoveAttachment,
  onUpdateAttachment,
  ...props
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || "");
  const [currentHeight, setCurrentHeight] = useState(44);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const textareaRef = useRef<RNTextInput>(null);

  // Internal attachment state (used when no controlled props)
  const [internalAttachments, setInternalAttachments] = useState<Attachment[]>(
    []
  );
  const attachments = controlledAttachments ?? internalAttachments;

  const addAttachment = useCallback(
    (a: Attachment) => {
      if (onAddAttachment) {
        onAddAttachment(a);
      } else {
        setInternalAttachments((prev) => [...prev, a]);
      }
    },
    [onAddAttachment]
  );

  const removeAttachment = useCallback(
    (id: string) => {
      if (onRemoveAttachment) {
        onRemoveAttachment(id);
      } else {
        setInternalAttachments((prev) => prev.filter((a) => a.id !== id));
      }
    },
    [onRemoveAttachment]
  );

  const updateAttachment = useCallback(
    (id: string, updates: Partial<Attachment>) => {
      if (onUpdateAttachment) {
        onUpdateAttachment(id, updates);
      } else {
        setInternalAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, ...updates } : a))
        );
      }
    },
    [onUpdateAttachment]
  );

  const handleChange = (newValue: string) => {
    setInternalValue(newValue);
    onValueChange?.(newValue);
  };

  const handleSubmit = () => {
    onSubmit?.();
    if (showFullscreen) setShowFullscreen(false);
  };

  useEffect(() => {
    if (!showFullscreen) setCurrentHeight(44);
  }, [showFullscreen]);

  const showExpandIcon = currentHeight > 100;
  const isSimpleMode = !children;

  const contextValue = {
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
    attachments,
    addAttachment,
    removeAttachment,
    updateAttachment,
  };

  const content = isSimpleMode ? (
    <>
      <PromptInputAttachments />
      <PromptInputTextarea
        placeholder={placeholder}
        className="min-h-[44px] text-base py-3"
      />
      <PromptInputActions className="flex-row items-center justify-between gap-2 mt-2 mb-1 px-3">
        <View className="flex-row items-center gap-1.5">
          {actionsLeft ?? <PromptInputAddMenu />}
        </View>
        <View className="flex-row items-center gap-1.5">
          <PromptInputMicButton />
          <PromptInputSubmitButton
            isLoading={isLoading}
            onStop={onStop}
            emptyAction={emptyAction}
          />
        </View>
      </PromptInputActions>
    </>
  ) : (
    children
  );

  const inputBox = (
    <Pressable
      onPress={() => {
        if (!disabled) textareaRef.current?.focus();
      }}
      disabled={disabled}
    >
      <View
        className={cn(
          "rounded-[24px] border border-border bg-background relative overflow-hidden",
          disabled && "opacity-60",
          className
        )}
        {...props}
      >
        {showExpandIcon && !disabled && (
          <Pressable
            onPress={() => setShowFullscreen(true)}
            className="absolute top-2 right-2 z-10 bg-background rounded-full p-1.5 border border-border active:opacity-70"
          >
            <Maximize2 size={16} className="text-muted-foreground" />
          </Pressable>
        )}
        {content}
      </View>
    </Pressable>
  );

  return (
    <PromptInputContext.Provider value={contextValue}>
      {autocomplete && <PromptInputAutocomplete />}

      <KeyboardAvoidingView behavior="padding">
        {leadingAddMenu ? (
          <View className="flex-row items-end gap-2">
            <PromptInputAddMenu
              iconSize={20}
              className="h-10 w-10 rounded-full border"
            />
            <View className="flex-1">{inputBox}</View>
          </View>
        ) : (
          inputBox
        )}
      </KeyboardAvoidingView>

      {showFullscreen && (
        <View
          style={{
            position: "fixed" as any,
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 9998,
          }}
          className="bg-background"
        >
          <Pressable
            onPress={() => setShowFullscreen(false)}
            className="absolute top-4 right-4 z-50 p-2 active:opacity-70 bg-background/80 rounded-full"
          >
            <Minimize2 size={20} className="text-foreground" />
          </Pressable>
          <View className="flex-1 flex-col">{content}</View>
        </View>
      )}
    </PromptInputContext.Provider>
  );
}
