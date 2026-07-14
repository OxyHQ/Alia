import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  type TextInput as RNTextInput,
} from "react-native";
import { KeyboardAvoidingView } from "@/lib/keyboard";
import { Maximize2, Minimize2 } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { asViewStyle } from "@/lib/types/webStyles";
import { PromptInputContext, type Attachment } from "./context";
import { PromptInputTextarea } from "./textarea";
import { PromptInputActions } from "./actions";
import { PromptInputMicButton } from "./mic-button";
import { PromptInputAutocomplete } from "./autocomplete";
import { PromptInputAttachments } from "./attachments";
import { PromptInputSubmitButton } from "./submit-button";
import { PromptInputAddMenu } from "./add-menu";

// Collapsed-state left inset (px) reserved for the pinned + button when measuring
// whether the current value fits the single-line middle track (see isExpanded).
const COLLAPSED_LEFT_INSET = 48;

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
  autocompletePosition?: "top" | "bottom";
  /** When true (empty conversation), show default welcome suggestions while the query is short. */
  showDefaultSuggestions?: boolean;
  // Render autocomplete as an absolute floating overlay above the pill (never
  // reserving layout space) instead of the inline top/bottom list — used by the
  // main chat so the centered welcome + input stay fixed while suggestions show.
  floatingAutocomplete?: boolean;
  // Custom right-side actions (rendered before mic + submit in the actions bar)
  actionsRight?: React.ReactNode;
  // Submit button props
  onStop?: () => void;
  emptyAction?: React.ReactNode;
  /** Send a suggestion's text directly (non-template selections) via the chat's send path. */
  onSuggestionSend?: (text: string) => void;
  // Controlled attachments (optional — uses internal state if omitted)
  attachments?: Attachment[];
  onAddAttachment?: (attachment: Attachment) => void;
  onRemoveAttachment?: (id: string) => void;
  onUpdateAttachment?: (id: string, updates: Partial<Attachment>) => void;
  /** When true, skip the inner KeyboardAvoidingView (use when an outer KeyboardStickyView already handles keyboard). */
  disableKeyboardAvoidance?: boolean;
} & Omit<React.ComponentProps<typeof View>, "children">;

export function PromptInput({
  className,
  isLoading = false,
  maxHeight = 400,
  value,
  onValueChange,
  onSubmit,
  children,
  disabled = false,
  onImagePaste,
  placeholder,
  autocomplete = false,
  autocompletePosition = "top",
  showDefaultSuggestions = false,
  floatingAutocomplete = false,
  actionsRight,
  onStop,
  emptyAction,
  onSuggestionSend,
  attachments: controlledAttachments,
  onAddAttachment,
  onRemoveAttachment,
  onUpdateAttachment,
  disableKeyboardAvoidance = false,
  ...props
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || "");
  const [currentHeight, setCurrentHeight] = useState(44);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const [handleCompletionKey, setHandleCompletionKey] = useState<((key: string) => boolean) | null>(null);
  const textareaRef = useRef<RNTextInput>(null);

  // Two-state (collapsed pill ↔ expanded) measurement — updated via onLayout so
  // the expansion trigger is derived in render, hysteresis-free, with no effect.
  const [containerWidth, setContainerWidth] = useState(0);
  const [rightClusterWidth, setRightClusterWidth] = useState(0);
  const [mirrorWidth, setMirrorWidth] = useState(0);

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

  const currentValue = value ?? internalValue;
  const currentSetValue = onValueChange ?? handleChange;

  // Expanded when the value can't sit on the collapsed single-line track: it
  // contains a newline, carries attachments, or its measured single-line width
  // exceeds the middle track (container − left inset − right action cluster).
  // Derived from measured widths only → deterministic, no oscillation: deleting
  // back under the fit width collapses again on its own.
  const middleWidth = containerWidth - COLLAPSED_LEFT_INSET - rightClusterWidth;
  const isExpanded =
    isSimpleMode &&
    !showFullscreen &&
    (currentValue.includes("\n") ||
      attachments.length > 0 ||
      (middleWidth > 0 && mirrorWidth > middleWidth));
  const contextValue = useMemo(() => ({
    isLoading,
    value: currentValue,
    setValue: currentSetValue,
    maxHeight,
    onSubmit: handleSubmit,
    onSuggestionSend,
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
    handleCompletionKey,
    setHandleCompletionKey,
  }), [
    isLoading, currentValue, currentSetValue, maxHeight, handleSubmit,
    onSuggestionSend, disabled, currentHeight, showFullscreen, onImagePaste,
    attachments, addAttachment, removeAttachment, updateAttachment,
    handleCompletionKey, setHandleCompletionKey,
  ]);

  const content = isSimpleMode ? (
    <>
      <PromptInputAttachments />
      {/* Collapsed: text sits on the single-line track between the pinned + (left)
          and the action cluster (right). Expanded: paddings shrink, a bottom band
          clears the pinned buttons, and text uses the full width above them. */}
      <PromptInputTextarea
        placeholder={placeholder}
        minHeight={showFullscreen ? undefined : isExpanded ? 0 : 60}
        className={
          showFullscreen
            ? "text-base"
            : isExpanded
              ? "min-h-0 max-h-[400px] pl-3.5 pr-3.5 pt-[18px] web:pt-[18px] pb-14 web:pb-14 text-base web:transition-[padding] web:duration-300 web:ease-out"
              : "min-h-[60px] max-h-[400px] pl-11 pr-[185px] pt-[18px] web:pt-[18px] pb-[18px] web:pb-[18px] text-base web:transition-[padding] web:duration-300 web:ease-out"
        }
      />
      <PromptInputActions
        pointerEvents={showFullscreen ? undefined : "box-none"}
        className={
          showFullscreen
            ? undefined
            : "absolute left-0 right-0 bottom-0 flex-row items-center p-2"
        }
      >
        <View className="flex-row items-center gap-1.5">
          <PromptInputAddMenu iconSize={20} className="h-10 w-10 rounded-full" />
        </View>
        <View
          className="ml-auto flex-row items-center gap-1"
          onLayout={(e) => setRightClusterWidth(e.nativeEvent.layout.width)}
        >
          {actionsRight}
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
          "border border-border bg-card shadow-sm relative overflow-hidden web:transition-[border-radius] web:duration-200",
          isExpanded ? "rounded-[32px]" : "rounded-full",
          disabled && "opacity-60",
          className
        )}
        {...props}
        onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
      >
        {/* Hidden single-line mirror of the current value in the input's font —
            its width drives the collapsed→expanded fit test. Measured on the
            wrapping View: react-native-web fires onLayout reliably on View but
            not on Text, so a bare <Text onLayout> never updates state (the
            symptom). The absolute row shrinks to the single-line text width. */}
        {isSimpleMode && (
          <View
            pointerEvents="none"
            onLayout={(e) => setMirrorWidth(e.nativeEvent.layout.width)}
            className="absolute top-0 left-0 flex-row opacity-0"
          >
            <Text numberOfLines={1} className="text-base lg:text-sm native:text-md">
              {currentValue}
            </Text>
          </View>
        )}
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
      {autocomplete && autocompletePosition === "top" && !floatingAutocomplete && (
        <PromptInputAutocomplete position="top" showDefaultSuggestions={showDefaultSuggestions} />
      )}

      {(() => {
        const Wrapper = disableKeyboardAvoidance ? View : KeyboardAvoidingView;
        const wrapperProps = disableKeyboardAvoidance ? {} : { behavior: "padding" as const };
        return (
          <Wrapper {...wrapperProps}>
            {floatingAutocomplete ? (
              <View className="relative">
                {autocomplete && autocompletePosition === "top" && (
                  // Overlay above the input — absolute so it never reserves layout
                  // space (keeps the centered welcome + input position fixed).
                  <View className="absolute left-0 right-0 bottom-full pb-2 z-50">
                    <PromptInputAutocomplete
                      position="top"
                      showDefaultSuggestions={showDefaultSuggestions}
                      className="rounded-2xl overflow-hidden p-1"
                    />
                  </View>
                )}
                {inputBox}
                {autocomplete && autocompletePosition === "bottom" && (
                  <PromptInputAutocomplete position="bottom" showDefaultSuggestions={showDefaultSuggestions} />
                )}
              </View>
            ) : (
              inputBox
            )}
          </Wrapper>
        );
      })()}

      {autocomplete && autocompletePosition === "bottom" && !floatingAutocomplete && (
        <PromptInputAutocomplete position="bottom" showDefaultSuggestions={showDefaultSuggestions} />
      )}

      {showFullscreen && (
        <View
          style={asViewStyle({
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 9998,
          })}
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
