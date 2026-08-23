import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  View,
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
import { PromptInputAutocomplete } from "./autocomplete";
import { PromptInputAttachments } from "./attachments";
import { PromptInputSubmitButton } from "./submit-button";
import { PromptInputAddMenu } from "./add-menu";
import { EffortSelector } from "@/components/effort-selector";

// Height (px) of the collapsed bar's single-line track.
const SINGLE_LINE_TRACK = 44;
// The textarea's own measured height crossing THIS expands the bar. It sits in
// the dead band between one line (~44px: a line box plus `py-2.5`) and two
// (~68px), rather than at the single-line height itself, because the two states
// do not carry the same vertical padding — expanded is `pt-2.5 pb-1`, collapsed
// is `py-2.5`. Thresholding one state's height against the other's exact track
// is the shape that oscillates: expand at 45, re-measure at 38, collapse, 45,
// expand. A band wider than the padding difference and narrower than a line
// cannot flip on the padding change alone.
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
  /**
   * Model id the reasoning-effort pill applies to. Supplying it puts the pill in
   * the composer's trailing cluster, between `actionsRight` and the mic — where
   * the effort control belongs, since effort is a property of the message about
   * to be sent and not of the conversation. Omit it and no pill renders.
   */
  effortForModel?: string;
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
  effortForModel,
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

  const handleSubmit = () => {
    onSubmit?.();
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

  const showExpandIcon = currentHeight > 100;
  const isSimpleMode = !children;

  const currentValue = value ?? internalValue;
  const currentSetValue = onValueChange ?? handleChange;

  // Does the value overflow the collapsed single-line track? The textarea's OWN
  // height answers it, on both platforms, because the collapsed row lays the
  // text out as `flex-1` between the two clusters rather than inside a padding-
  // reserved track — so there is no reserved width left to model.
  //
  // That is what replaced a canvas `measureText` on web plus an off-screen text
  // mirror on native: three measured widths (container, right cluster, mirror)
  // and two hardcoded padding constants existed only to RECONSTRUCT a width the
  // layout engine already knows. `onHeightChange` reads a plain `View` carrying
  // an inline style, which is the one thing react-native-web does report
  // reliably — the caveat in `chat-text-input.tsx` is about className'd nodes.
  //
  // Still derived in render and still hysteresis-free: delete back under one
  // line and the height falls, so it collapses again on its own.
  const overflowsTrack = currentHeight > EXPAND_ABOVE;

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

  // The two clusters, spelled once. They are the SAME nodes in both states —
  // only which flex box holds them changes — so nothing about a button's
  // behaviour can drift between collapsed and expanded.
  const leadingCluster = (
    <PromptInputAddMenu iconSize={20} className="h-9 w-9 rounded-full" />
  );
  const trailingCluster = (
    <>
      {actionsRight}
      {effortForModel != null && <EffortSelector selectedModel={effortForModel} />}
      <PromptInputMicButton />
      <PromptInputSubmitButton
        isLoading={isLoading}
        onStop={onStop}
        emptyAction={emptyAction}
      />
    </>
  );

  const content = isSimpleMode ? (
    <>
      <PromptInputAttachments />
      {/* Collapsed the bar is ONE flex row: (+) | text | actions, with the text
          as `flex-1`. Expanded it is a column: the text takes the full width and
          the two clusters sit on a row beneath it.

          This is the reflow ChatGPT gets from `grid-template-areas`, which
          React Native has no equivalent for — Yoga implements flexbox only, so a
          grid would be web-only and native would collapse to a single column.
          Expressed as flex it is one layout for both platforms.

          It also removes the reason the old version had to MEASURE anything: the
          text used to sit in a track carved out with `pl-11 pr-[185px]`, so the
          bar had to know how wide the right cluster had grown to. `flex-1` is
          the layout engine answering the same question. */}
      {barState === "fullscreen" ? (
        <>
          <PromptInputTextarea id={inputId} placeholder={placeholder} className="text-base" />
          <PromptInputActions>
            {leadingCluster}
            <View className="ml-auto flex-row items-center gap-1">{trailingCluster}</View>
          </PromptInputActions>
        </>
      ) : barState === "expanded" ? (
        <View className="px-2 pt-1 pb-2">
          <PromptInputTextarea
            id={inputId}
            placeholder={placeholder}
            minHeight={0}
            className="min-h-0 max-h-[400px] px-1.5 pt-2.5 web:pt-2.5 pb-1 web:pb-1 text-base"
          />
          <View className="flex-row items-center gap-1 pt-1">
            {leadingCluster}
            <View className="ml-auto flex-row items-center gap-1">{trailingCluster}</View>
          </View>
        </View>
      ) : (
        <View className="flex-row items-center gap-1 px-2 py-1.5 min-h-[52px]">
          {leadingCluster}
          {/* `flex-1` with `min-w-0`: without the min-width override a flex item
              refuses to shrink below its content, so a long unbroken value would
              push the action cluster off the bar instead of scrolling inside. */}
          <View className="flex-1 min-w-0">
            <PromptInputTextarea
              id={inputId}
              placeholder={placeholder}
              minHeight={SINGLE_LINE_TRACK}
              className="min-h-[44px] max-h-[400px] px-1.5 py-2.5 web:py-2.5 text-base"
            />
          </View>
          <View className="flex-row items-center gap-1">{trailingCluster}</View>
        </View>
      )}
    </>
  ) : (
    children
  );

  const barNode = (
      <View
        className={cn(
          "border border-border bg-card shadow-sm relative overflow-hidden web:transition-[border-radius] web:duration-200",
          barState === "fullscreen"
            ? "border-0 bg-background"
            : barState === "expanded"
              ? "rounded-[28px]"
              : "rounded-full",
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
        {barState === "fullscreen" ? (
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
