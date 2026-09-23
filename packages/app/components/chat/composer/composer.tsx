import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import {
  ComposerPanel,
  type ComposerPanelAddMenuGroup,
  type ComposerPanelAttachment,
  type ComposerPanelPermissionOption,
  type ModelPickerProvider,
} from "@oxy.so/bloom/composer-panel";
import { toast } from "@oxy.so/bloom/toast";
import { MAX_ATTACHMENT_BYTES } from "@/lib/chat/attachment-intake";
import { KeyboardAvoidingView } from "@/lib/keyboard";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useSpeechToText } from "@/lib/hooks/use-speech-to-text";
import { useComposerPasteTarget } from "./drop-zone";
import { releaseRemovedAttachment, useAttachmentIntake } from "./use-attachment-intake";
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
  attachments?: readonly Attachment[];
  onAddAttachment?: (attachment: Attachment) => void;
  onRemoveAttachment?: (id: string) => void;
  /** The tab on the card's top edge (`ComposerPanelStatusTab`). */
  status?: ReactNode;
  /** Drawn where send would be while there is nothing to send (voice mode). */
  emptyAction?: ReactNode;
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
  attachments: controlledAttachments,
  onAddAttachment,
  onRemoveAttachment,
  status,
  emptyAction,
  onKeyPress,
  disableKeyboardAvoidance = false,
}: ComposerProps) {
  const { t } = useTranslation();
  // Paste is a DOM gesture on a DOM node; the panel publishes no ref to one.
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
  const removeAttachment = useCallback(
    (id: string) => {
      releaseRemovedAttachment(attachments, id);
      if (onRemoveAttachment !== undefined) onRemoveAttachment(id);
      else setInternalAttachments((previous) => previous.filter((a) => a.id !== id));
    },
    [attachments, onRemoveAttachment],
  );
  const intake = useAttachmentIntake({ addAttachment });
  useComposerPasteTarget({ elementId: hostId, enabled: !disabled && !busy, onFiles: intake.accept });

  // Bloom's tiles have no error state, so a file that could not be read or
  // was refused is said once, in a toast, and leaves the queue.
  useEffect(() => {
    for (const item of intake.items) {
      if (item.status === "reading") continue;
      const name = item.name || t("composer.untitled");
      toast.error(
        item.status === "refused"
          ? item.refusal === "too-large"
            ? t("composer.fileTooLarge", {
                name,
                limit: `${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB`,
              })
            : t("composer.fileEmpty", { name })
          : t("composer.readFailed", { name }),
      );
      intake.dismiss(item.id);
    }
  }, [intake, t]);

  // Landed files, then the ones still being read with their real progress.
  const tiles = useMemo<ComposerPanelAttachment[]>(
    () => [
      ...attachments.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.type === "image" ? ("image" as const) : ("document" as const),
        src: a.type === "image" ? a.uri : undefined,
      })),
      ...intake.items
        .filter((item) => item.status === "reading")
        .map((item) => ({
          id: item.id,
          name: item.name || t("composer.untitled"),
          kind: item.kind === "image" ? ("image" as const) : ("document" as const),
          progress: item.fraction === null ? 0 : Math.round(item.fraction * 100),
        })),
    ],
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
    if (stt.error !== null) toast.error(stt.error);
  }, [stt.error]);

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
    </View>
  );

  return disableKeyboardAvoidance ? host : <KeyboardAvoidingView behavior="padding">{host}</KeyboardAvoidingView>;
}
