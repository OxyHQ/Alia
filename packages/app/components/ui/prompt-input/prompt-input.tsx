import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  View,
  Text,
  Pressable,
  Platform,
  type TextInput as RNTextInput,
  type ViewStyle,
} from "react-native";
import { KeyboardAvoidingView } from "@/lib/keyboard";
import { Maximize2, Minimize2 } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { asViewStyle } from "@/lib/types/webStyles";
import { Portal } from "@oxyhq/bloom/portal";
import { PromptInputContext, type Attachment } from "./context";
import { PromptInputTextarea } from "./textarea";
import { PromptInputActions } from "./actions";
import { PromptInputMicButton } from "./mic-button";
import { PromptInputDictationBar } from "./dictation-bar";
import { useSpeechToText } from "@/lib/hooks/use-speech-to-text";
import { PromptInputAutocomplete } from "./autocomplete";
import { PromptInputAttachments } from "./attachments";
import { PromptInputSubmitButton } from "./submit-button";
import { PromptInputAddMenu } from "./add-menu";
import { ModelSelector } from "@/components/model-selector";
import { EffortSelector } from "@/components/effort-selector";
import { useIsLargeScreen } from "@/lib/hooks/use-is-large-screen";

// Height (px) of the collapsed bar's single-line track.
const SINGLE_LINE_TRACK = 44;
// Height above which the text no longer fits the collapsed single-line track.
// The value compared with this threshold is always measured at the COLLAPSED
// text width, even while the visible composer is expanded. That stable frame of
// reference is what prevents expand/collapse feedback loops near a line wrap.
const EXPAND_ABOVE = 56;

// Fullscreen grow (web): animate the fixed bar's insets + radius. A comma'd
// property list is unwieldy as an arbitrary NW class, so it rides on the style.
const FS_TRANSITION =
  "top 300ms ease-out, left 300ms ease-out, right 300ms ease-out, bottom 300ms ease-out, border-radius 200ms ease-in-out";
// Duration to keep the fixed layout alive while the exit shrink animates back.
const FS_EXIT_MS = 300;

type BarRect = { top: number; left: number; right: number; bottom: number };

// The fixed fullscreen bar starts pinned to the captured on-screen `barRect` and
// animates its viewport insets to 0 (full screen). `settled` — or a missing rect
// (rAF never fired / capture failed) — is the end state: inset 0, square corners.
function fullscreenGrowStyle(barRect: BarRect | null, settled: boolean): ViewStyle {
  if (settled || !barRect) {
    return asViewStyle({
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 9998,
      borderWidth: 0,
      borderRadius: 0,
      transition: FS_TRANSITION,
    });
  }
  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;
  return asViewStyle({
    position: "fixed",
    top: barRect.top,
    left: barRect.left,
    right: Math.max(0, vw - barRect.right),
    bottom: Math.max(0, vh - barRect.bottom),
    zIndex: 9998,
    borderWidth: 0,
    borderRadius: 32,
    transition: FS_TRANSITION,
  });
}

export type PromptInputProps = {
  isLoading?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  maxHeight?: number;
  /**
   * Submit the composer. The optional value is for a submission whose text was
   * never typed — dictation hands over what it just transcribed, because the
   * consumer holds the draft in its own state and a set-then-submit in one tick
   * would send the text from before the recording.
   */
  onSubmit?: (value?: string) => void;
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
  /** Chat-only controls. Supplying both turns the generic input into the unified composer. */
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  composerMenu?: React.ReactNode;
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
  selectedModel,
  onModelChange,
  composerMenu,
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
  const [collapsedMeasureHeight, setCollapsedMeasureHeight] = useState(SINGLE_LINE_TRACK);
  const [leadingWidth, setLeadingWidth] = useState(0);
  const [trailingWidth, setTrailingWidth] = useState(0);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const isLargeScreen = useIsLargeScreen();
  // Fullscreen grow choreography (web): the captured bar rect + whether it has
  // settled to full-screen. Native ignores these and snaps.
  const [barRect, setBarRect] = useState<BarRect | null>(null);
  const [fsSettled, setFsSettled] = useState(false);
  const fsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [handleCompletionKey, setHandleCompletionKey] = useState<((key: string) => boolean) | null>(null);
  const textareaRef = useRef<RNTextInput>(null);
  // Stable DOM id for the textarea (colons stripped so it's a clean HTML id).
  // Strip everything non-alphanumeric: react-native-web sanitizes exotic chars
  // (React 19's useId wraps ids in punctuation) when writing the DOM `id`, so a
  // caller that looks the node up by this id gets a byte-identical string.
  const inputId = `prompt-input-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

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

  const handleSubmit = (dictated?: string) => {
    onSubmit?.(dictated);
    // Clicking the send button (as opposed to pressing Enter) shifts DOM focus
    // to the button on web — restore it so the user can keep typing.
    textareaRef.current?.focus();
    if (showFullscreen) {
      if (fsTimer.current) {
        clearTimeout(fsTimer.current);
        fsTimer.current = null;
      }
      setShowFullscreen(false);
      setFsSettled(false);
      setBarRect(null);
    }
  };

  // Enter/exit fullscreen as an in-place GROW of the same bar (web). Enter:
  // capture the bar's viewport rect, mount fixed pinned to it, then double-rAF →
  // settle (insets animate to 0). Exit: un-settle (shrink back to the rect), then
  // after the transition drop back to in-flow layout. Native snaps directly.
  const toggleFullscreen = () => {
    if (fsTimer.current) {
      clearTimeout(fsTimer.current);
      fsTimer.current = null;
    }
    if (showFullscreen) {
      setFsSettled(false);
      if (Platform.OS === "web") {
        fsTimer.current = setTimeout(() => {
          setShowFullscreen(false);
          setBarRect(null);
          fsTimer.current = null;
        }, FS_EXIT_MS);
      } else {
        setShowFullscreen(false);
        setBarRect(null);
      }
      return;
    }
    if (Platform.OS === "web") {
      const el =
        typeof document !== "undefined"
          ? document.getElementById(`${inputId}-bar`)
          : null;
      const rect = el?.getBoundingClientRect();
      setBarRect(
        rect
          ? { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom }
          : null,
      );
      setFsSettled(!rect); // no rect → skip the grow, land settled
      setShowFullscreen(true);
      if (rect) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            setFsSettled(true);
            // The portal re-parents the bar, remounting the input — restore focus.
            document.getElementById(inputId)?.focus();
          }),
        );
      }
    } else {
      setBarRect(null);
      setFsSettled(true);
      setShowFullscreen(true);
    }
  };

  useEffect(() => {
    if (!showFullscreen) setCurrentHeight(44);
  }, [showFullscreen]);

  const isSimpleMode = !children;

  /**
   * One recorder for the whole composer.
   *
   * `useSpeechToText` creates its own `useAudioRecorder`, so calling it in both
   * the mic button and the dictation bar would leave the stop control acting on
   * a recorder nobody is speaking into. It is created here and handed to both.
   */
  const stt = useSpeechToText();
  const isDictating = stt.isRecording || stt.isTranscribing;
  const isChatComposer = selectedModel !== undefined && onModelChange !== undefined;

  const currentValue = value ?? internalValue;
  const currentSetValue = onValueChange ?? handleChange;

  // Measuring the visible textarea caused a genuine feedback loop: collapsed
  // text has less width because it shares the row with the controls, while the
  // expanded textarea spans the full bar. A value could therefore wrap in the
  // collapsed state, expand, fit on one line at the wider width, collapse, and
  // repeat. The invisible mirror below always retains the collapsed width.
  const stableCollapsedHeight =
    leadingWidth > 0 && trailingWidth > 0 ? collapsedMeasureHeight : currentHeight;
  const overflowsTrack = stableCollapsedHeight > EXPAND_ABOVE;
  const showExpandIcon = !isChatComposer && stableCollapsedHeight > 100;

  // Three visual states of the SAME bar. Fullscreen wins; otherwise the value's
  // fit decides collapsed vs expanded. (Fullscreen is entered via the maximize
  // affordance, not derived from content.)
  const isExpanded =
    isSimpleMode &&
    ((isChatComposer && !isLargeScreen)
      || currentValue.includes("\n")
      || attachments.length > 0
      || overflowsTrack);
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
    /**
     * Wrapped so it takes NOTHING, and the wrapper is load-bearing.
     *
     * `handleSubmit` accepts an optional dictated string, and three consumers
     * pass this straight to an event handler — `onPress`, `onSubmitEditing`,
     * `onEnterPress`. A function with an optional parameter is assignable to
     * `() => void`, so every type in the chain is satisfied while the press
     * EVENT arrives as the first argument at runtime and is read as the text to
     * send. That shipped, and typing a message stopped sending it.
     *
     * Dictation calls `handleSubmit(text)` directly instead, which is the only
     * caller that has text to hand over.
     */
    onSubmit: () => handleSubmit(),
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

  // The two clusters, spelled once. They are the SAME nodes in both states —
  // only their grid areas change — so nothing about a button's behaviour can
  // drift between collapsed and expanded.
  const leadingCluster = (
    <View
      className="flex-row items-center"
      onLayout={(event) => setLeadingWidth(event.nativeEvent.layout.width)}
    >
      <PromptInputAddMenu iconSize={20} className="h-9 w-9 rounded-full">
        {composerMenu}
      </PromptInputAddMenu>
    </View>
  );
  const trailingCluster = (
    <View
      className="flex-row items-center gap-1"
      onLayout={(event) => setTrailingWidth(event.nativeEvent.layout.width)}
    >
      {selectedModel !== undefined && onModelChange !== undefined && (
        <>
          <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} />
          {Platform.OS !== "web" && <EffortSelector selectedModel={selectedModel} />}
        </>
      )}
      <PromptInputMicButton stt={stt} />
      <PromptInputSubmitButton
        isLoading={isLoading}
        onStop={onStop}
        emptyAction={emptyAction}
      />
    </View>
  );

  /**
   * Dictation replaces the composer's content rather than reflowing inside it.
   *
   * Nothing that belongs to typing applies to a voice mid-sentence, and the
   * typing layout is a CSS grid on web and absolutely anchored controls on
   * native — threading a fourth state through both would make every future
   * change to either answer for a mode it has nothing to do with.
   */
  const dictationContent = (
    <PromptInputDictationBar
      isTranscribing={stt.isTranscribing}
      onCancel={stt.cancel}
      onStop={async () => {
        const text = await stt.stopAndTranscribe();
        if (text) currentSetValue(currentValue ? `${currentValue} ${text}` : text);
      }}
      onSend={async () => {
        const text = await stt.stopAndTranscribe();
        if (!text) return;
        const next = currentValue ? `${currentValue} ${text}` : text;
        currentSetValue(next);
        // Submitted WITH the text rather than after setting it: the consumer
        // holds the draft in its own state, so a submit in this same tick would
        // send what was there before the recording.
        handleSubmit(next);
      }}
    />
  );

  const content = isSimpleMode ? (
    <>
      <PromptInputAttachments />
      {/* Keep ONE textarea and ONE set of controls mounted. On web this is the
          reference's CSS grid: collapsed is `leading primary trailing`, while
          expanded changes only `grid-template-areas` so primary spans the top
          row. Native uses the same stable nodes with absolutely anchored
          controls because Yoga has no CSS grid. */}
      {barState === "fullscreen" ? (
        <>
          <PromptInputTextarea id={inputId} placeholder={placeholder} className="text-base" />
          <PromptInputActions>
            {leadingCluster}
            <View className="ml-auto">{trailingCluster}</View>
          </PromptInputActions>
        </>
      ) : (
        <View
          className={cn(
            "relative min-w-0 px-2 web:grid web:grid-cols-[auto_minmax(0,1fr)_auto] web:gap-x-1",
            barState === "expanded"
              ? "pt-1 pb-11 web:pb-2 web:gap-y-1 web:[grid-template-areas:'primary_primary_primary'_'leading_footer_trailing']"
              : "min-h-[52px] py-1 web:items-center web:[grid-template-areas:'leading_primary_trailing']",
          )}
        >
          <View
            className={cn(
              "min-w-0 web:[grid-area:primary]",
              barState === "collapsed" && "h-[44px] overflow-hidden",
            )}
            style={
              Platform.OS !== "web" && barState === "collapsed"
                ? {
                    marginLeft: leadingWidth + 4,
                    marginRight: trailingWidth + 4,
                  }
                : undefined
            }
          >
            <PromptInputTextarea
              id={inputId}
              placeholder={placeholder}
              minHeight={barState === "collapsed" ? SINGLE_LINE_TRACK : 0}
              className={cn(
                "max-h-[400px] px-1.5 text-base",
                barState === "collapsed"
                  ? "min-h-[44px] py-2.5 web:py-2.5"
                  : "min-h-0 pt-2.5 web:pt-2.5 pb-1 web:pb-1",
              )}
            />
          </View>
          <View
            className={cn(
              "self-center web:static web:[grid-area:leading]",
              "absolute left-2 z-10",
              barState === "expanded"
                ? "bottom-2"
                : "top-2",
            )}
          >
            {leadingCluster}
          </View>
          <View
            className={cn(
              "self-center web:static web:[grid-area:trailing]",
              "absolute right-2 z-10",
              barState === "expanded"
                ? "bottom-2"
                : "top-2",
            )}
          >
            {trailingCluster}
          </View>
        </View>
      )}
    </>
  ) : (
    children
  );

  const barNode = (
      <View
        className={cn(
          "relative overflow-hidden bg-card shadow-sm web:transition-[border-radius] web:duration-200",
          isChatComposer
            ? "rounded-[28px] border-0 web:shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.04),0_4px_40px_8px_rgba(0,0,0,0.025)]"
            : "border border-border",
          barState === "fullscreen"
            ? "border-0 bg-background"
            : barState === "expanded"
              ? "rounded-[28px]"
              : isChatComposer ? "rounded-[28px]" : "rounded-full",
          disabled && "opacity-60",
          className
        )}
        {...props}
        // Fullscreen GROWS the same bar from its captured on-screen rect to the
        // viewport (native snaps) — the rect-derived insets are runtime values, so
        // they ride on `style`; `id` is how the rect is captured (refs don't reach
        // the DOM node under NW5). Both after {...props} so nothing clobbers them.
        id={`${inputId}-bar`}
        style={barState === "fullscreen" ? fullscreenGrowStyle(barRect, fsSettled) : undefined}
      >
        {isSimpleMode && barState !== "fullscreen" && leadingWidth > 0 && trailingWidth > 0 && (
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              position: "absolute",
              top: 0,
              left: 8 + leadingWidth + 4,
              right: 8 + trailingWidth + 4,
              opacity: 0,
            }}
          >
            <Text
              accessible={false}
              className="min-h-[44px] px-1.5 py-2.5 text-base lg:text-sm web:whitespace-pre-wrap web:break-words"
              onLayout={(event) => setCollapsedMeasureHeight(event.nativeEvent.layout.height)}
            >
              {currentValue || "\u200b"}
            </Text>
          </View>
        )}
        {!disabled && (showFullscreen || showExpandIcon) && (
          <Pressable
            onPress={toggleFullscreen}
            className="absolute top-2 right-2 z-10 bg-background rounded-full p-1.5 border border-border active:opacity-70"
          >
            {showFullscreen ? (
              <Minimize2 size={16} className="text-muted-foreground" />
            ) : (
              <Maximize2 size={16} className="text-muted-foreground" />
            )}
          </Pressable>
        )}
        {isDictating ? (
          dictationContent
        ) : barState === "fullscreen" ? (
          // Container-transform: the frame flies while the content cross-fades —
          // hidden during the grow/shrink, visible once settled. Without this the
          // inner layout snaps to fullscreen instantly and the motion reads broken.
          <View
            className={cn(
              "flex-1 flex-col web:transition-opacity web:duration-150",
              fsSettled ? "opacity-100" : "opacity-0"
            )}
          >
            {content}
          </View>
        ) : (
          content
        )}
      </View>
  );

  const inputBox = (
    <Pressable
      onPress={() => {
        if (!disabled) textareaRef.current?.focus();
      }}
      disabled={disabled}
    >
      {/* Fullscreen renders through a root portal: any transformed ancestor
          (the drawer animates with translate) turns position:fixed into
          absolute-like positioning trapped UNDER the sidebar. The portal
          escapes that containing block; the spacer holds the layout slot. */}
      {barState === "fullscreen" ? <Portal>{barNode}</Portal> : barNode}
      {showFullscreen && barRect != null && (
        <View style={{ height: barRect.bottom - barRect.top }} />
      )}
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
