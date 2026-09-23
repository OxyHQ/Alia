import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import { ComposerLoader } from "@oxy.so/bloom/composer-loader";
import { ComposerPill, type ComposerPanelAddMenuGroup, type ModelPickerModel } from "@oxy.so/bloom/composer-panel";
import { toast } from "@oxy.so/bloom/toast";
import { KeyboardAvoidingView } from "@/lib/keyboard";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useSpeechToText } from "@/lib/hooks/use-speech-to-text";
import { ComposerAttachmentStrip } from "./attachment-strip";
import { ComposerAutocomplete } from "./autocomplete";
import { DictationBar } from "./dictation-bar";
import {
  ComposerDropOverlay,
  useComposerDropTarget,
  useComposerPasteTarget,
} from "./drop-zone";
import {
  releaseRemovedAttachment,
  useAttachmentIntake,
} from "./use-attachment-intake";
import { COMPOSER_RADIUS, type Attachment } from "./types";

/**
 * Alia's composer: Bloom's `ComposerPill`, and the four things that are not it.
 *
 * ## What Bloom owns now
 *
 * The field, its growth, Enter, Shift+Enter, the input method's Enter, the add
 * menu, the model menu, the effort slider inside it, the mic, the send disc and
 * the stop disc. All of it was Alia's a commit ago — 2,984 lines across eleven
 * files, including a CSS grid, a hand-rolled fullscreen choreography, an
 * invisible `Text` mirror that existed only to measure text at a width the
 * visible field was not, and a submit button that reimplemented "disabled" four
 * times. None of that is here, because none of it was ever Alia's problem; it
 * was the cost of not having a composer in the design system.
 *
 * It follows Bloom's own AI Chat template:
 *
 *     <ComposerLoader active={working}>
 *       <ComposerPill surface={false} glass={working} … />
 *     </ComposerLoader>
 *
 * The loader paints the surface and the pill does not, which is the inversion
 * of what Alia did before — the old bar painted `bg-card` under a three-part
 * shadow and mounted the light INSIDE itself with `surface={false}`, because
 * the light was being bolted onto a bar it had not been designed for. Now the
 * light is the frame and the pill sits in it, and the two agree about the
 * corner without anybody restating it.
 *
 * The page composes `ComposerStatusBar` below this control with its actual
 * Chat/Agent mode. Branch, local-folder and context metrics are omitted because
 * Alia does not expose those values.
 *
 * ## What is composed as a sibling, and why each one has to be
 *
 *  - **The attachment strip.** `ComposerPillProps` declares no attachments.
 *    See `attachment-strip.tsx`.
 *  - **The suggestion list.** It is a surface ABOVE the composer, and it is
 *    driven by the keyboard — which is possible at all because `onKeyPress`
 *    fires the field's keys before the pill's own Enter rule and stops at a
 *    `defaultPrevented` event.
 *  - **The dictation bar.** Bloom models the mic as `listening`, a presentation
 *    flag with no recorder behind it. That is the right division for a UI kit
 *    and the wrong one here: Alia's state is three-way (idle, recording,
 *    transcribing), the transcription can fail and has to say so, and the audio
 *    has to reach somewhere. So the flag drives Bloom's mic, and the recording
 *    itself REPLACES the pill, exactly as it did before — nothing that belongs
 *    to typing applies to a voice mid-sentence.
 *  - **The drop overlay.** A drop is a DOM gesture on a DOM node, and the pill
 *    is a `View` with a `style` and a `testID`. The composer wraps it in an
 *    element with an id and the listeners go there.
 *
 * ## The two locks, which are not the same lock
 *
 * `busy` is a turn in flight: send becomes stop, and stop is outside
 * `disabled`'s reach by Bloom's own contract, which is the property the old
 * composer had to fight its own DOM to keep. `disabled` is everything that
 * should grey send — the usage limit, an empty draft, a file whose bytes have
 * not arrived. They are passed separately because they mean different things
 * and Bloom treats them differently.
 */
/**
 * No menu at all, hoisted so it is one array for the life of the module rather
 * than a fresh one per render feeding Bloom's `addMenu.length > 0`.
 */
const EMPTY_ADD_MENU: readonly ComposerPanelAddMenuGroup[] = [];

export interface ComposerProps {
  /** The draft. Controlled: the page owns it, because the page restores it. */
  value: string;
  onValueChange: (value: string) => void;
  /**
   * Send.
   *
   * The optional value is for a submission whose text was never typed —
   * dictation hands over what it just transcribed, because the consumer holds
   * the draft in its own state and a set-then-submit in one tick would send
   * the text from before the recording.
   */
  onSubmit: (value?: string) => void;
  /** A turn is in flight: send becomes stop and Enter no longer sends. */
  busy?: boolean;
  /** The usage limit, and nothing else. A stream is `busy`. */
  disabled?: boolean;
  onStop?: () => void;
  placeholder?: string;
  /** The shorter placeholder below 640 wide, where the full one clips. */
  compactPlaceholder?: string;

  /** The model lineup. Omitted, the pill draws no model chip. */
  models?: readonly ModelPickerModel[];
  model?: string;
  onModelChange?: (modelId: string) => void;
  /** `[]` drops the effort half of the model panel, which is the common case. */
  effortLevels?: readonly string[];
  /** An index into `effortLevels`, or `null` for "the model decides". */
  effort?: number | null;
  onEffortChange?: (effort: number) => void;

  /**
   * The add menu's groups.
   *
   * Omitted, there is NO menu — and that default is the opposite of Bloom's,
   * deliberately. `ComposerPillProps.addMenu` falls back to
   * `COMPOSER_PANEL_ADD_MENU`, the kit's own demo rows, which is the right
   * default for a component somebody is trying out and the wrong one for a
   * product: the agent-creation prompt has nothing to attach to, and left to
   * Bloom it would have drawn a plus button offering "Plugins" and reporting
   * the press to a handler that does not exist.
   */
  addMenu?: readonly ComposerPanelAddMenuGroup[];
  onAddMenuSelect?: (rowId: string) => void;

  /**
   * The attachment list, when the page owns it. Omitted, the composer keeps
   * its own — which is what the agent-creation prompt does, having nothing to
   * attach to and no store to keep it in.
   */
  attachments?: readonly Attachment[];
  onAddAttachment?: (attachment: Attachment) => void;
  onRemoveAttachment?: (id: string) => void;

  autocomplete?: boolean;
  autocompletePosition?: "top" | "bottom";
  /** When true (empty conversation), show default welcome suggestions while the query is short. */
  showDefaultSuggestions?: boolean;
  onSuggestionSend?: (text: string) => void;
  /**
   * Draw the list as an absolute overlay above the pill rather than in the
   * flow, so the centred welcome and the composer under it do not move as
   * suggestions appear and go.
   */
  floatingAutocomplete?: boolean;

  /**
   * Drawn where send would be while the draft is empty and no turn is in
   * flight — Alia's voice-call button.
   *
   * Withheld automatically while anything IS attached: a turn with a picture
   * and no words is a turn that can be sent, and Bloom decides the slot on the
   * text alone.
   */
  emptyAction?: React.ReactNode;
  /** How many lines the pill grows to before the field scrolls. Bloom's default is 8. */
  maxLines?: number;
  /** Skip the inner `KeyboardAvoidingView` when an outer sticky view already handles the keyboard. */
  disableKeyboardAvoidance?: boolean;
}

export function Composer({
  value,
  onValueChange,
  onSubmit,
  busy = false,
  disabled = false,
  onStop,
  placeholder,
  compactPlaceholder,
  models,
  model,
  onModelChange,
  effortLevels,
  effort,
  onEffortChange,
  addMenu,
  onAddMenuSelect,
  attachments: controlledAttachments,
  onAddAttachment,
  onRemoveAttachment,
  autocomplete = false,
  autocompletePosition = "top",
  showDefaultSuggestions = false,
  onSuggestionSend,
  floatingAutocomplete = false,
  emptyAction,
  maxLines,
  disableKeyboardAvoidance = false,
}: ComposerProps) {
  const { t } = useTranslation();

  /**
   * A stable DOM id for the element the pill is mounted inside.
   *
   * Everything non-alphanumeric is stripped: react-native-web sanitises exotic
   * characters (React 19's `useId` wraps ids in punctuation) when writing the
   * DOM `id`, so a lookup by this string gets a byte-identical one back.
   */
  const hostId = `composer-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const [internalAttachments, setInternalAttachments] = useState<Attachment[]>([]);
  const attachments = controlledAttachments ?? internalAttachments;

  const addAttachment = useCallback(
    (attachment: Attachment) => {
      if (onAddAttachment !== undefined) onAddAttachment(attachment);
      else setInternalAttachments((previous) => [...previous, attachment]);
    },
    [onAddAttachment],
  );

  /**
   * Drop an attachment — and give back whatever it was holding.
   *
   * The release is the point of the wrapper. On web BOTH Expo pickers return
   * `URL.createObjectURL(file)` as the attachment's `uri`, and Alia revoked
   * none of them: every image and document picked in a browser pinned its own
   * bytes in the page for the life of the tab, whether or not the user took it
   * straight back out of the composer.
   *
   * Only on an explicit removal, and NOT when the list is emptied by a send.
   * The chat page clears the attachments before awaiting the request, and the
   * attachment's `uri` is still what the sent turn renders from — revoking on
   * "the list got shorter" would blank the picture in the transcript at the
   * moment the message appeared.
   */
  const removeAttachment = useCallback(
    (id: string) => {
      releaseRemovedAttachment(attachments, id);
      if (onRemoveAttachment !== undefined) onRemoveAttachment(id);
      else setInternalAttachments((previous) => previous.filter((a) => a.id !== id));
    },
    [attachments, onRemoveAttachment],
  );

  const intake = useAttachmentIntake({ addAttachment });

  /**
   * Nothing may be attached to a composer the usage limit has closed, or to a
   * turn already streaming. It is asked of the drop AND of the paste, because
   * a gesture that bypasses a locked control is a lock that only applies to
   * people using the mouse.
   */
  const canAttach = !disabled && !busy;

  /**
   * One recorder for the whole composer.
   *
   * `useSpeechToText` creates its own `useAudioRecorder`, so calling it in two
   * places would leave the control that stops dictation acting on a recorder
   * nobody is speaking into. It is created here and both the pill's mic and
   * the dictation bar act on this one.
   */
  const stt = useSpeechToText();
  const dictating = stt.isRecording || stt.isTranscribing;

  useEffect(() => {
    if (stt.error !== null) toast.error(stt.error);
  }, [stt.error]);

  /**
   * The suggestion list's key handler, while it has rows to steer.
   *
   * A ref and not state, and read in the same tick the key arrives: `onKeyPress`
   * runs synchronously before the pill's Enter rule, so a handler read one
   * render late is a handler read too late for the only Enter that matters.
   */
  const completionKey = useRef<((key: string) => boolean) | null>(null);
  const setCompletionKey = useCallback((handler: ((key: string) => boolean) | null) => {
    completionKey.current = handler;
  }, []);

  /**
   * The field's keys, before the composer's own Enter rule.
   *
   * `preventDefault()` takes the key, and Bloom stops at a defaulted event —
   * which is the only ordering that lets the suggestion list win Enter while
   * the field keeps it the rest of the time. The IME's Enter is NOT asked
   * about here: Bloom's own rule already reads `native.isComposing` (the same
   * condition Alia's `imeOwnsEnter` was written from, which is why that
   * function and its test went with the old composer), and asking twice in two
   * places is how two answers drift.
   */
  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const handler = completionKey.current;
      if (handler === null) return;
      const key = event.nativeEvent.key;
      if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "Enter" && key !== "Escape") return;
      if (handler(key)) event.preventDefault();
    },
    [],
  );

  const isDragOver = useComposerDropTarget({
    elementId: hostId,
    enabled: canAttach,
    onFiles: intake.accept,
  });
  useComposerPasteTarget({
    elementId: hostId,
    enabled: canAttach,
    onFiles: intake.accept,
  });

  /**
   * A file still being read is not attached yet.
   *
   * It has no `uri`, and `buildMessageContent` filters the list on exactly
   * that — so a turn sent mid-read goes out without the picture and looks to
   * the user like one that went out with it.
   */
  const reading = intake.isBusy;
  const hasContent = value.trim() !== "" || attachments.length > 0;

  const handleSubmit = useCallback(() => {
    // Bloom hands back the text it holds; the page holds the same string and
    // is the one that clears it, so the argument is dropped on purpose.
    onSubmit();
  }, [onSubmit]);

  /**
   * Start dictating.
   *
   * Bloom's mic is a toggle over a controlled `listening`, and `listening` is
   * false for as long as this pill is mounted — the moment the recorder starts
   * the dictation bar replaces the pill entirely. So the only transition that
   * can reach here is false → true, and the guard is the one the old mic
   * button carried: dictation writes into the same draft typing does, so it is
   * locked by the same two things.
   */
  const handleListeningChange = useCallback(
    (next: boolean) => {
      if (!next || disabled || busy || stt.isTranscribing) return;
      stt.startRecording();
    },
    [disabled, busy, stt],
  );

  const appendDictated = useCallback(
    (text: string) => (value === "" ? text : `${value} ${text}`),
    [value],
  );

  const pillLabels = useMemo(
    () => ({
      message: t("composer.message"),
      addMenu: t("composer.addMenu"),
      voice: t("composer.voice"),
      send: t("composer.send"),
      stop: t("composer.stop"),
      effortAuto: t("effort.levels.default"),
    }),
    [t],
  );

  const suggestions = autocomplete ? (
    <ComposerAutocomplete
      position={autocompletePosition}
      showDefaultSuggestions={showDefaultSuggestions}
      value={value}
      setValue={onValueChange}
      onSuggestionSend={onSuggestionSend}
      onKeyHandlerChange={setCompletionKey}
      className={floatingAutocomplete ? "rounded-2xl overflow-hidden p-1" : undefined}
    />
  ) : null;

  const bar = dictating ? (
    /*
     * The composer while it is listening. Everything that belongs to typing is
     * gone, because none of it applies to a voice that is mid-sentence, and
     * what is left is the three things a person can do about a recording in
     * progress: throw it away, stop it, or send it.
     */
    <DictationBar
      isTranscribing={stt.isTranscribing}
      onCancel={stt.cancel}
      onStop={async () => {
        const text = await stt.stopAndTranscribe();
        if (text !== null) onValueChange(appendDictated(text));
      }}
      onSend={async () => {
        const text = await stt.stopAndTranscribe();
        if (text === null) return;
        const next = appendDictated(text);
        onValueChange(next);
        // Submitted WITH the text rather than after setting it: the consumer
        // holds the draft in its own state, so a submit in this same tick
        // would send what was there before the recording.
        onSubmit(next);
      }}
    />
  ) : (
    <ComposerPill
      value={value}
      onValueChange={onValueChange}
      onSubmit={handleSubmit}
      onStop={onStop}
      busy={busy}
      /*
       * Everything that should grey send, folded into the one prop Bloom
       * offers for it — and deliberately NOT reaching the stop control, which
       * is the contract this whole adoption turns on. `!hasContent` is in here
       * because a composer with nothing in it has nothing to send; a read in
       * flight is because the bytes are not there yet.
       */
      disabled={disabled || reading || !hasContent}
      placeholder={placeholder}
      compactPlaceholder={compactPlaceholder}
      addMenu={addMenu ?? EMPTY_ADD_MENU}
      onAddMenuSelect={onAddMenuSelect}
      models={models}
      model={model}
      onModelChange={onModelChange}
      effortLevels={effortLevels}
      effort={effort}
      onEffortChange={onEffortChange}
      listening={false}
      onListeningChange={handleListeningChange}
      onKeyPress={handleKeyPress}
      /*
       * Withheld while a file is attached or still arriving. Bloom decides the
       * slot on the DRAFT alone (`text.trim() === ''`), which is right for a
       * composer that has no attachments and wrong for one that does: a
       * picture with no caption is a turn that can be sent, and the voice
       * button standing where send should be would make it unsendable.
       */
      emptyAction={attachments.length > 0 || reading ? undefined : emptyAction}
      maxLines={maxLines}
      // The loader paints the surface behind it. See the note at the top.
      surface={false}
      glass={busy}
      labels={pillLabels}
    />
  );

  const host = (
    // The id, and the only reason this wrapper exists: drop and paste are DOM
    // gestures on a DOM node, and Bloom's pill publishes neither a ref that
    // resolves to one nor an id to look one up by.
    <View id={hostId} className="relative">
      <ComposerAttachmentStrip
        attachments={attachments}
        onRemove={removeAttachment}
        intake={intake}
      />
      <ComposerLoader
        active={busy && !dictating}
        /*
         * The pill's own corner, stated rather than left to the default.
         *
         * At rest the two are the same drawing — half of Bloom's 52 is the 26
         * a `9999` radius resolves to on that box — so nothing changes for the
         * common case. Once the draft has grown they are not: the pill squares
         * off to a literal 26 and the loader's default would go on tracing a
         * pill around a box that had stopped being one.
         */
        radius={COMPOSER_RADIUS}
      >
        {bar}
      </ComposerLoader>
      {/*
       * LAST, so it covers the draft and the controls rather than sliding
       * under them — a drop affordance the field draws over is one the user
       * reads as a background.
       */}
      <ComposerDropOverlay visible={isDragOver} enabled={canAttach} />
    </View>
  );

  const Wrapper = disableKeyboardAvoidance ? View : KeyboardAvoidingView;
  const wrapperProps = disableKeyboardAvoidance ? {} : { behavior: "padding" as const };

  return (
    <>
      {suggestions !== null && autocompletePosition === "top" && !floatingAutocomplete && suggestions}
      <Wrapper {...wrapperProps}>
        {floatingAutocomplete ? (
          <View className="relative">
            {suggestions !== null && autocompletePosition === "top" && (
              // Absolute so it never reserves layout space, which is what keeps
              // the centred welcome and the composer under it from moving as
              // suggestions appear.
              <View className="absolute left-0 right-0 bottom-full pb-2 z-50">{suggestions}</View>
            )}
            {host}
            {suggestions !== null && autocompletePosition === "bottom" && suggestions}
          </View>
        ) : (
          host
        )}
      </Wrapper>
      {suggestions !== null && autocompletePosition === "bottom" && !floatingAutocomplete && suggestions}
    </>
  );
}
