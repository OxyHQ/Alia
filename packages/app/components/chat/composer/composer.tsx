import { useCallback, useEffect, useId, useMemo, type ReactNode } from "react";
import { View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import {
  ComposerPanel,
  type ComposerPanelAddMenuGroup,
  type ComposerPanelPermissionOption,
  type ModelPickerProvider,
} from "@oxy.so/bloom/composer-panel";
import { toast } from "@oxy.so/bloom/toast";
import { KeyboardAvoidingView } from "@/lib/keyboard";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useSpeechToText } from "@/lib/hooks/use-speech-to-text";
import { voiceErrorText } from "@/lib/voice-error-text";
import { composerTiles, intakeError } from "./attachment-tiles";
import { ComposerDropOverlay, useComposerDropTarget, useComposerPasteTarget } from "./drop-zone";
import { useAttachmentIntake } from "./use-attachment-intake";
import type { Attachment } from "./types";

/**
 * Alia's composer is Bloom's `ComposerPanel`. A running turn is its stop
 * control and the container's thinking line; the panel takes no loader
 * (Bloom's loader traces the pill, and would light the status tab too).
 *
 * Everything the panel draws is Bloom's: the prompt, the add menu, the mode
 * selector (the panel's permission pill), the model picker with its provider
 * rail and effort chip, the mic, send / stop, the attachment tiles and the
 * status tab. Alia supplies the data and the handlers.
 */
const EMPTY_ADD_MENU: readonly ComposerPanelAddMenuGroup[] = [];
/** `[]` hides the selector; Bloom's own four modes are not Alia's. */
const NO_MODES: readonly ComposerPanelPermissionOption[] = [];
const NO_ATTACHMENTS: readonly Attachment[] = [];

export interface ComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Sends the draft; `dictated` is text transcribed in the same tick. */
  onSubmit: (dictated?: string) => void;
  /** A turn is streaming: send becomes stop, the loader runs. */
  busy?: boolean;
  /** The composer is closed (usage limit). Never reaches stop. */
  disabled?: boolean;
  onStop?: () => void;
  placeholder?: string;
  /** The model picker's rail. Omit to hide the picker. */
  providers?: readonly ModelPickerProvider[];
  model?: string;
  onModelChange?: (modelId: string) => void;
  effortLevels?: readonly string[];
  effort?: number | null;
  onEffortChange?: (effort: number) => void;
  /** The mode selector. Omit to hide it. */
  modes?: readonly ComposerPanelPermissionOption[];
  mode?: string;
  onModeChange?: (mode: string) => void;
  addMenu?: readonly ComposerPanelAddMenuGroup[];
  onAddMenuSelect?: (rowId: string) => void;
  /**
   * The draft's files. A composer given no `onAddAttachment` takes none: its
   * surface sends nothing but the text, so no paste, drop or tile may say
   * otherwise.
   */
  attachments?: readonly Attachment[];
  onAddAttachment?: (attachment: Attachment) => void;
  onRemoveAttachment?: (id: string) => void;
  /** The tab on the card's top edge (`ComposerPanelStatusTab`). */
  status?: ReactNode;
  /** Drawn where send would be while there is nothing to send (voice mode). */
  emptyAction?: ReactNode;
  /**
   * Drawn over the conversation at the composer's top-right corner, and so
   * pinned with it — the jump to the newest turn.
   */
  accessory?: ReactNode;
  /** The field's keys, before the panel's own Enter rule (suggestions over it). */
  onKeyPress?: (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => void;
  /** The host already avoids the keyboard. */
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
  providers,
  model,
  onModelChange,
  effortLevels,
  effort,
  onEffortChange,
  modes,
  mode,
  onModeChange,
  addMenu,
  onAddMenuSelect,
  attachments = NO_ATTACHMENTS,
  onAddAttachment,
  onRemoveAttachment,
  status,
  emptyAction,
  accessory,
  onKeyPress,
  disableKeyboardAvoidance = false,
}: ComposerProps) {
  const { t } = useTranslation();
  // Paste is a DOM gesture on a DOM node; the panel publishes no ref to one.
  const hostId = `composer-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  // The list's owner releases what a removed tile held (the draft store does).
  const takesFiles = onAddAttachment !== undefined;
  const addAttachment = useCallback(
    (attachment: Attachment) => onAddAttachment?.(attachment),
    [onAddAttachment],
  );
  const removeAttachment = useCallback((id: string) => onRemoveAttachment?.(id), [onRemoveAttachment]);
  const intake = useAttachmentIntake({ addAttachment });
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

  // The intake keeps a failed read with its error and its file, for a retry
  // (`intake.retry`), and `composerTiles` gives it an error tile. Bloom's
  // tiles cannot draw an error yet, so until they can it is said once, in a
  // toast, and leaves the queue.
  useEffect(() => {
    for (const item of intake.items) {
      const error = intakeError(item, t);
      if (error === undefined) continue;
      toast.error(error);
      intake.dismiss(item.id);
    }
  }, [intake, t]);

  // Landed files, then the ones still being read with their real progress.
  const tiles = useMemo(
    () => composerTiles(attachments, intake.items, t).filter((tile) => tile.error === undefined),
    [attachments, intake.items, t],
  );
  const removeTile = useCallback(
    (id: string) => {
      if (intake.items.some((item) => item.id === id)) intake.cancel(id);
      else removeAttachment(id);
    },
    [intake, removeAttachment],
  );

  const stt = useSpeechToText();
  useEffect(() => {
    const text = voiceErrorText(t, stt.errorCode);
    if (text !== null) toast.error(text);
  }, [stt.errorCode]);

  const handleListeningChange = useCallback(
    async (next: boolean) => {
      if (next) {
        if (!disabled && !busy && !stt.isTranscribing) stt.startRecording();
        return;
      }
      const text = await stt.stopAndTranscribe();
      if (text !== null) onValueChange(value === "" ? text : `${value} ${text}`);
    },
    [disabled, busy, stt, value, onValueChange],
  );

  const hasContent = value.trim() !== "" || attachments.length > 0;
  const labels = useMemo(
    () => ({
      message: t("composer.message"),
      addMenu: t("composer.addMenu"),
      permissions: t("composer.modes"),
      permissionMode: t("composer.modes"),
      voice: t("composer.voice"),
      send: t("composer.send"),
      stop: t("composer.stop"),
      remove: t("composer.removeShort"),
    }),
    [t],
  );
  const modelPickerLabels = useMemo(
    () => ({
      models: t("composer.models"),
      quickSearch: t("composer.quickSearch"),
      searchPlaceholder: t("composer.searchModels"),
      noMatches: t("composer.noModels"),
      providers: t("composer.providers"),
      effort: t("composer.effort"),
      effortAuto: t("effort.levels.default"),
      faster: t("composer.faster"),
      smarter: t("composer.smarter"),
    }),
    [t],
  );

  const host = (
    // The transcript's column (Bloom's `AgentChat`: 768 at most, centred), so
    // the composer and the conversation share one edge.
    <View id={hostId} className="w-full max-w-[768px] self-center">
      <ComposerPanel
        value={value}
        onValueChange={onValueChange}
        onSubmit={() => onSubmit()}
        busy={busy}
        onStop={onStop}
        disabled={disabled || intake.isBusy || !hasContent}
        placeholder={placeholder}
        addMenu={addMenu ?? EMPTY_ADD_MENU}
        onAddMenuSelect={onAddMenuSelect}
        permissions={modes ?? NO_MODES}
        permission={mode}
        onPermissionChange={onModeChange}
        providers={providers}
        model={model}
        onModelChange={onModelChange}
        effortLevels={effortLevels}
        effort={effort}
        onEffortChange={onEffortChange}
        modelPickerLabels={modelPickerLabels}
        listening={stt.isRecording}
        onListeningChange={(next) => void handleListeningChange(next)}
        attachments={tiles}
        onRemoveAttachment={removeTile}
        status={status}
        emptyAction={emptyAction}
        onKeyPress={onKeyPress}
        labels={labels}
      />
      <ComposerDropOverlay visible={takesFiles && isDragOver} enabled={acceptsFiles} />
      {accessory ? (
        <View pointerEvents="box-none" className="absolute bottom-full right-0 mb-2">
          {accessory}
        </View>
      ) : null}
    </View>
  );

  return disableKeyboardAvoidance ? host : <KeyboardAvoidingView behavior="padding">{host}</KeyboardAvoidingView>;
}
