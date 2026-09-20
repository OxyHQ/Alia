import React from "react";
import {
  Platform,
  StyleSheet,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/hooks/use-translation";
import { imeOwnsEnter } from "@/lib/chat/composer-state";
import { ChatTextInput } from "../chat-text-input";
import { usePromptInput } from "./context";

export type PromptInputTextareaProps = {
  placeholder?: string;
  className?: string;
} & React.ComponentProps<typeof ChatTextInput>;

export function PromptInputTextarea({
  className,
  placeholder,
  style,
  onKeyPress,
  ...props
}: PromptInputTextareaProps) {
  const {
    value,
    setValue,
    onSubmit,
    disabled,
    isLoading,
    textareaRef,
    setCurrentHeight,
    isFullscreen,
    maxHeight,
    onImagePaste,
    handleCompletionKey,
  } = usePromptInput();
  const { t } = useTranslation();

  const inputStyle = React.useMemo(
    () => [style, styles.borderless, isFullscreen && styles.fullscreen],
    [isFullscreen, style],
  );

  /**
   * Whether the key event currently being handled arrived mid-composition.
   *
   * A ref rather than state, and read in the SAME tick it is written.
   * `ChatTextInput.handleKeyPress` calls `onKeyPress` first and decides Enter
   * immediately afterwards, synchronously, from the one event — so the flag is
   * set and consumed before React could have re-rendered anything. State here
   * would be read one render too late, which is to say always for the Enter
   * that matters.
   */
  const composing = React.useRef(false);

  const noteComposition = (
    event: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) => {
    /*
     * `isComposing` is a DOM `KeyboardEvent` field that react-native-web passes
     * through on the nativeEvent; no native platform reports anything like it,
     * so the question is asked of web alone — the same guard Bloom's own
     * composers open with (`!IS_WEB || … || native.isComposing`).
     */
    const native = event.nativeEvent as TextInputKeyPressEventData & {
      isComposing?: boolean;
    };
    composing.current = imeOwnsEnter({
      isWeb: Platform.OS === "web",
      isComposing: native.isComposing === true,
    });
    onKeyPress?.(event);
  };

  /**
   * Send, unless this Enter was the input method's.
   *
   * `ChatTextInput` decides Enter by one question — is Shift down? — and it is
   * the right question for a Latin keyboard and the wrong one for every input
   * method that uses Enter to accept a candidate. Under the old rule the first
   * Enter of a Japanese, Chinese or Korean sentence SENT it, and the word being
   * confirmed then landed in the empty composer behind it.
   *
   * The veto lives here rather than in `ChatTextInput` because that component
   * is shared with inputs that have no composer semantics at all, and because
   * the flag it needs is already in flight through `onKeyPress` above.
   */
  const submitUnlessComposing = () => {
    if (composing.current) return;
    onSubmit?.();
  };

  const textInput = (
    <ChatTextInput
      ref={textareaRef}
      value={value}
      onChangeText={setValue}
      onSubmitEditing={submitUnlessComposing}
      onEnterPress={submitUnlessComposing}
      onKeyPress={noteComposition}
      onHeightChange={setCurrentHeight}
      onCompletionKey={handleCompletionKey ?? undefined}
      disableEnterToSubmit={isFullscreen}
      disableAutoHeight={isFullscreen}
      maxHeight={isFullscreen ? 10000 : maxHeight}
      onImagePaste={onImagePaste}
      fillContainer={isFullscreen}
      unstyled
      className={cn(
        "w-full border-0 bg-transparent text-foreground web:shadow-none",
        isFullscreen ? "px-4 pt-4" : "min-h-[44px] py-3",
        className
      )}
      style={inputStyle}
      underlineColorAndroid="transparent"
      placeholder={placeholder}
      // The field's accessible name, in the reader's language. `ChatTextInput`
      // hard-codes an English "Message input" for every input that uses it;
      // stated here it is overridden for the composer alone, which is the one
      // that is bilingual because the whole product around it is. Bloom names
      // the same string `ComposerPanelLabels.message`.
      accessibilityLabel={t("composer.message")}
      multiline
      // The composer's lock lives HERE, on the control, rather than on a
      // wrapper around the whole bar: a stream blocks typing the next message
      // (`isLoading`) and the usage limit blocks the composer (`disabled`), and
      // neither may reach the stop button beside this field.
      editable={!disabled && !isLoading}
      noFocus={true}
      {...props}
    />
  );

  if (isFullscreen) {
    return <View style={{ flex: 1 }}>{textInput}</View>;
  }

  return textInput;
}

const styles = StyleSheet.create({
  borderless: {
    borderWidth: 0,
  },
  fullscreen: {
    paddingBottom: 100,
  },
});
