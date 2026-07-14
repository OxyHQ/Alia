import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  Platform,
  type TextInput as RNTextInput,
} from "react-native";
import { KeyboardAvoidingView } from "@/lib/keyboard";
import { Maximize2, Minimize2 } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { asViewStyle } from "@/lib/types/webStyles";
import { overflowsSingleLine } from "@/lib/measure-text-fit";
import { PromptInputContext, type Attachment } from "./context";
import { PromptInputTextarea } from "./textarea";
import { PromptInputActions } from "./actions";
import { PromptInputMicButton } from "./mic-button";
import { PromptInputAutocomplete } from "./autocomplete";
import { PromptInputAttachments } from "./attachments";
import { PromptInputSubmitButton } from "./submit-button";
import { PromptInputAddMenu } from "./add-menu";

// Native onLayout path: left inset (px) reserved for the pinned + button when
// measuring whether the value fits the collapsed single-line middle track.
const COLLAPSED_LEFT_INSET = 48;
// Web canvas path: horizontal padding of the collapsed editor (pl-11 + pr-[185px])
// subtracted from the input's inner width to get the single-line text track.
const COLLAPSED_H_PADDING = 44 + 185;

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
  // Stable DOM id for the textarea (colons stripped so it's a clean HTML id).
  // The web fit test resolves the node by id, not by ref — see overflowsSingleLine.
  // Strip everything non-alphanumeric: react-native-web sanitizes exotic chars
  // (React 19's useId wraps ids in punctuation) when writing the DOM `id`, and
  // the lookup string must be byte-identical to what lands in the DOM.
  const inputId = `prompt-input-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

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

  // Does the value overflow the collapsed single-line track? Web measures the
  // text with canvas 2D `measureText` against the input's inner width, resolving
  // the node by DOM id (under NativeWind 5 / react-native-css neither `onLayout`
  // nor the forwarded ref reach the host node for className'd elements, so both
  // silently no-op on web). Native falls back to the onLayout-measured mirror vs
  // the middle track. Derived in render → deterministic, hysteresis-free: delete
  // back under the fit width and it collapses again on its own.
  const webOverflow = overflowsSingleLine(inputId, currentValue, COLLAPSED_H_PADDING);
  const nativeMiddleWidth = containerWidth - COLLAPSED_LEFT_INSET - rightClusterWidth;
  const overflowsTrack =
    webOverflow ?? (nativeMiddleWidth > 0 && mirrorWidth > nativeMiddleWidth);

  // Three visual states of the SAME bar. Fullscreen wins; otherwise the value's
  // fit decides collapsed vs expanded. (Fullscreen is entered via the maximize
  // affordance, not derived from content.)
  const isExpanded =
    isSimpleMode &&
    (currentValue.includes("\n") || attachments.length > 0 || overflowsTrack);
  const barState: "collapsed" | "expanded" | "fullscreen" = showFullscreen
    ? "fullscreen"
    : isExpanded
      ? "expanded"
      : "collapsed";
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
      {/* Verification note: the padding/radius transitions FREEZE in a hidden
          browser tab (Chrome pauses CSS transitions), so computed styles read
          from automation stay at the from-value — check state flips in a real
          foregrounded tab, or read the class attribute instead. */}
      <PromptInputTextarea
        id={inputId}
        placeholder={placeholder}
        minHeight={barState === "fullscreen" ? undefined : barState === "expanded" ? 0 : 60}
        className={
          barState === "fullscreen"
            ? "text-base"
            : barState === "expanded"
              ? "min-h-0 max-h-[400px] pl-3.5 pr-3.5 pt-[18px] web:pt-[18px] pb-14 web:pb-14 text-base web:transition-[padding] web:duration-300 web:ease-out"
              : "min-h-[60px] max-h-[400px] pl-11 pr-[185px] pt-[18px] web:pt-[18px] pb-[18px] web:pb-[18px] text-base web:transition-[padding] web:duration-300 web:ease-out"
        }
      />
      <PromptInputActions
        pointerEvents={barState === "fullscreen" ? undefined : "box-none"}
        className={
          barState === "fullscreen"
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
          barState === "fullscreen"
            ? "rounded-none border-0 bg-background"
            : barState === "expanded"
              ? "rounded-[32px]"
              : "rounded-full",
          disabled && "opacity-60",
          className
        )}
        {...props}
        // Fullscreen is the SAME bar growing to cover the screen (web fixed
        // positioning; native ignores `fixed` and snaps in place), not a
        // separate overlay component. After {...props} so it can't be clobbered.
        style={
          barState === "fullscreen"
            ? asViewStyle({ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 9998 })
            : undefined
        }
        onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
      >
        {/* Hidden single-line mirror of the current value in the input's font —
            drives the native fit test. Measured on the wrapping View: react-
            native-web fires onLayout reliably on View but not on Text. On web the
            fit test uses canvas measureText instead (onLayout is unreliable for
            className'd elements under NativeWind 5), so this is native-only. */}
        {isSimpleMode && Platform.OS !== "web" && (
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
        {!disabled && (showFullscreen || showExpandIcon) && (
          <Pressable
            onPress={() => setShowFullscreen(!showFullscreen)}
            className="absolute top-2 right-2 z-10 bg-background rounded-full p-1.5 border border-border active:opacity-70"
          >
            {showFullscreen ? (
              <Minimize2 size={16} className="text-muted-foreground" />
            ) : (
              <Maximize2 size={16} className="text-muted-foreground" />
            )}
          </Pressable>
        )}
        {barState === "fullscreen" ? (
          <View className="flex-1 flex-col">{content}</View>
        ) : (
          content
        )}
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
    </PromptInputContext.Provider>
  );
}
