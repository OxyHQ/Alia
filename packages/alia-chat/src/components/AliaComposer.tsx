import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  View,
  type NativeSyntheticEvent,
  type TextInput,
  type TextInputKeyPressEventData,
} from 'react-native';
import {
  ComposerPanel,
  type ComposerPanelAddMenuGroup,
  type ComposerPanelAttachment,
  type ComposerPanelPermissionOption,
} from '@oxy.so/bloom/composer-panel';
import { toast } from '@oxy.so/bloom/toast';
import { useAttachmentIntake } from '../hooks/useAttachmentIntake';
import { useSpeechToText } from '../hooks/useSpeechToText';
import type { Completion } from '../lib/suggestions';
import { composerTiles, intakeError } from '../lib/attachment-tiles';
import type { IntakeKind } from '../lib/attachment-intake';
import { KeyboardAvoidingView } from '../lib/keyboard';
import { type AliaChatLabels, AliaChatLabelsProvider, useLabels } from '../lib/labels';
import type { AskedQuestion } from '../lib/questions';
import type { VoiceErrorCode } from '../lib/speech-messages';
import type { AliaAttachment, AliaSuggestion } from '../types';
import {
  ComposerDropOverlay,
  useComposerDropTarget,
  useComposerPasteTarget,
} from './ComposerDropZone';
import { ComposerSuggestions } from './ComposerSuggestions';
import { QuestionCard } from './QuestionCard';

/**
 * Alia's composer: the ONE composer of the sheet, the screen and the Alia app, Bloom's
 * `ComposerPanel` plus everything Alia puts around it.
 *
 * Everything the panel draws is Bloom's: the prompt, the add menu, the mode selector (the
 * panel's permission pill, which is the host's power-level selector), the mic, send / stop, the
 * attachment tiles and the status tab. What this adds is what every Alia surface needs the same
 * way: files arriving by paste and drop (read with real progress, retried, refused with a
 * sentence), dictation, the suggestions over the field, and the questions Alia asked docked
 * above it. What differs per surface is a prop: the add menu and the modes are the host's,
 * and a host that offers no way to attach files gets no paste or drop either.
 *
 * A running turn is the stop control and the container's thinking line; the panel takes no
 * loader (Bloom's loader traces the pill, and would light the status tab too).
 */
const EMPTY_ADD_MENU: readonly ComposerPanelAddMenuGroup[] = [];
/** `[]` hides the selector; Bloom's own four modes are not Alia's. */
const NO_MODES: readonly ComposerPanelPermissionOption[] = [];
const NO_ATTACHMENTS: readonly AliaAttachment[] = [];

/** The rows over the field, as `useComposerSuggestions` hands them back. */
export interface AliaComposerSuggestions<T extends AliaSuggestion = AliaSuggestion> {
  completions: readonly Completion<T>[];
  /** The row the keyboard is on, or -1. */
  selected: number;
  onPick: (suggestion: T) => void;
}

/** The questions Alia asked and the person has not answered (`usePendingQuestions`). */
export interface AliaComposerQuestions {
  items: AskedQuestion[];
  /** Sends the answers as the next message. */
  onSubmit: (message: string) => void;
  onDismiss: () => void;
}

export interface AliaComposerProps<T extends AliaSuggestion = AliaSuggestion> {
  value: string;
  onValueChange: (value: string) => void;
  /** Sends the draft. */
  onSubmit: () => void;
  /** A turn is streaming: send becomes stop. */
  busy?: boolean;
  /** The composer is closed (usage limit). Never reaches stop. */
  disabled?: boolean;
  onStop?: () => void;
  placeholder?: string;
  /** The mode selector (the power levels). Omit to hide it. */
  modes?: readonly ComposerPanelPermissionOption[];
  mode?: string;
  onModeChange?: (mode: string) => void;
  addMenu?: readonly ComposerPanelAddMenuGroup[];
  onAddMenuSelect?: (rowId: string) => void;
  /**
   * The draft's files. A composer given no `onAddAttachment` takes none: its surface sends
   * nothing but the text, so no paste, drop or tile may say otherwise.
   */
  attachments?: readonly AliaAttachment[];
  onAddAttachment?: (attachment: AliaAttachment) => void;
  onRemoveAttachment?: (id: string) => void;
  /** The kinds of file the host's send carries; others are refused with a sentence. Default both. */
  attachmentKinds?: readonly IntakeKind[];
  /** The suggestions drawn over the field. Their keys are the host's `onKeyPress`. */
  suggestions?: AliaComposerSuggestions<T>;
  /** What Alia is waiting on, docked above the composer. */
  questions?: AliaComposerQuestions;
  /** The tab on the card's top edge (`ComposerPanelStatusTab`). */
  status?: ReactNode;
  /** Drawn where send would be while there is nothing to send (voice mode). */
  emptyAction?: ReactNode;
  /**
   * Drawn over the conversation at the composer's top-right corner, and so pinned with it —
   * the jump to the newest turn.
   */
  accessory?: ReactNode;
  /** The field's keys, before the panel's own Enter rule (suggestions over it). */
  onKeyPress?: (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => void;
  /** The host already avoids the keyboard. */
  disableKeyboardAvoidance?: boolean;
  /** The field itself, for a host that moves focus into it. */
  inputRef?: RefObject<TextInput | null>;
  /** Dictation's language, a BCP-47 tag; omitted, the platform's own. */
  speechLanguage?: string;
  /** Where a refused file or a failed dictation is said; omitted, Bloom's toast. */
  onError?: (message: string) => void;
  /** The composer's copy, over whatever labels are already in reach. */
  labels?: Partial<AliaChatLabels>;
}

function AliaComposerBody<T extends AliaSuggestion>({
  value,
  onValueChange,
  onSubmit,
  busy = false,
  disabled = false,
  onStop,
  placeholder,
  modes,
  mode,
  onModeChange,
  addMenu,
  onAddMenuSelect,
  attachments = NO_ATTACHMENTS,
  onAddAttachment,
  onRemoveAttachment,
  attachmentKinds,
  suggestions,
  questions,
  status,
  emptyAction,
  accessory,
  onKeyPress,
  disableKeyboardAvoidance = false,
  inputRef,
  speechLanguage,
  onError,
}: Omit<AliaComposerProps<T>, 'labels'>) {
  const labels = useLabels();
  const report = useCallback(
    (message: string) => (onError ? onError(message) : toast.error(message)),
    [onError],
  );
  // Paste is a DOM gesture on a DOM node; the panel publishes no ref to one.
  const hostId = `composer-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  // The list's owner releases what a removed tile held (the draft store does).
  const takesFiles = onAddAttachment !== undefined;
  const addAttachment = useCallback(
    (attachment: AliaAttachment) => onAddAttachment?.(attachment),
    [onAddAttachment],
  );
  const removeAttachment = useCallback(
    (id: string) => onRemoveAttachment?.(id),
    [onRemoveAttachment],
  );
  const intake = useAttachmentIntake({ addAttachment, kinds: attachmentKinds });
  // A surface that takes no files still catches a drop or a pasted file, so
  // the browser does not open it in place of the page — and then does nothing.
  const acceptsFiles = takesFiles && !disabled && !busy;
  useComposerPasteTarget({ elementId: hostId, enabled: acceptsFiles, onFiles: intake.accept });
  // Web only; on native there is no drag, and the hook attaches nothing.
  const isDragOver = useComposerDropTarget({
    elementId: hostId,
    enabled: acceptsFiles,
    onFiles: intake.accept,
  });

  /**
   * A refused file — too large, or empty — is said once, in a toast, and
   * leaves the queue.
   *
   * It is not a tile because Bloom's retry is the PANEL's: with
   * `onAttachmentRetry` set, every error tile draws a retry button, and a
   * refusal has nothing to retry — the same file reaches the same verdict.
   * A tile whose button does nothing is worse than a sentence.
   * A failed READ stays, as an error tile whose retry re-reads its file.
   */
  useEffect(() => {
    for (const item of intake.items) {
      if (item.status !== 'refused') continue;
      const error = intakeError(item, labels);
      if (error !== undefined) report(error);
      intake.dismiss(item.id);
    }
  }, [intake, labels, report]);

  // Landed files, then the ones being read with their real progress, then the
  // ones whose read failed, with why.
  const tiles = useMemo<ComposerPanelAttachment[]>(
    () =>
      composerTiles(attachments, intake.items, labels)
        .filter((tile) => tile.error === undefined || tile.retryable === true)
        .map(({ retryable: _retryable, ...tile }) => tile),
    [attachments, intake.items, labels],
  );
  const removeTile = useCallback(
    (id: string) => {
      if (intake.items.some((item) => item.id === id)) intake.cancel(id);
      else removeAttachment(id);
    },
    [intake, removeAttachment],
  );

  const stt = useSpeechToText({ lang: speechLanguage });
  // Said once per failure: a host re-rendering with new labels is not a new failure.
  const sayVoiceError = useRef((code: VoiceErrorCode) => report(labels.voiceError(code)));
  sayVoiceError.current = (code) => report(labels.voiceError(code));
  useEffect(() => {
    if (stt.errorCode !== null) sayVoiceError.current(stt.errorCode);
  }, [stt.errorCode]);

  const handleListeningChange = useCallback(
    async (next: boolean) => {
      if (next) {
        if (!disabled && !busy && !stt.isTranscribing) stt.startRecording();
        return;
      }
      const text = await stt.stopAndTranscribe();
      if (text !== null) onValueChange(value === '' ? text : `${value} ${text}`);
    },
    [disabled, busy, stt, value, onValueChange],
  );

  const hasContent = value.trim() !== '' || attachments.length > 0;
  const panelLabels = useMemo(
    () => ({
      message: labels.composerMessage,
      addMenu: labels.composerAddMenu,
      permissions: labels.composerModes,
      permissionMode: labels.composerModes,
      voice: labels.composerVoice,
      send: labels.composerSend,
      stop: labels.composerStop,
      remove: labels.composerRemove,
      // Bloom names the button "<retry> <file name>".
      retry: labels.composerRetry,
    }),
    [labels],
  );

  const host = (
    // The transcript's column (Bloom's `AgentChat`: 768 at most, centred), so
    // the composer and the conversation share one edge.
    <View id={hostId} className="w-full max-w-[768px] self-center">
      <ComposerPanel
        value={value}
        onValueChange={onValueChange}
        onSubmit={() => onSubmit()}
        inputRef={inputRef}
        busy={busy}
        onStop={onStop}
        disabled={disabled || intake.isBusy || !hasContent}
        placeholder={placeholder ?? labels.placeholder}
        addMenu={addMenu ?? EMPTY_ADD_MENU}
        onAddMenuSelect={onAddMenuSelect}
        permissions={modes ?? NO_MODES}
        permission={mode}
        onPermissionChange={onModeChange}
        voiceState={stt.isTranscribing ? 'transcribing' : stt.isRecording ? 'recording' : 'idle'}
        onVoiceStateChange={(next) => void handleListeningChange(next === 'recording')}
        attachments={tiles}
        onRemoveAttachment={removeTile}
        // Clears the tile's error and starts its progress again: `intake.retry`
        // puts the item back to `reading` over the same `File`.
        onAttachmentRetry={intake.retry}
        question={
          questions && questions.items.length > 0 ? (
            <QuestionCard
              questions={questions.items}
              onSubmit={questions.onSubmit}
              onDismiss={questions.onDismiss}
            />
          ) : undefined
        }
        status={status}
        emptyAction={emptyAction}
        onKeyPress={onKeyPress}
        labels={panelLabels}
      />
      <ComposerDropOverlay visible={takesFiles && isDragOver} enabled={acceptsFiles} />
      {accessory ? (
        <View pointerEvents="box-none" className="absolute bottom-full right-0 mb-2">
          {accessory}
        </View>
      ) : null}
    </View>
  );

  return (
    <>
      {suggestions ? (
        <ComposerSuggestions
          completions={suggestions.completions}
          selected={suggestions.selected}
          onPick={suggestions.onPick}
        />
      ) : null}
      {disableKeyboardAvoidance ? (
        host
      ) : (
        <KeyboardAvoidingView behavior="padding">{host}</KeyboardAvoidingView>
      )}
    </>
  );
}

export function AliaComposer<T extends AliaSuggestion = AliaSuggestion>({
  labels,
  ...props
}: AliaComposerProps<T>) {
  return (
    <AliaChatLabelsProvider labels={labels}>
      <AliaComposerBody {...props} />
    </AliaChatLabelsProvider>
  );
}
