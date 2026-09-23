import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { View } from "react-native";
import { ComposerLoader } from "@oxy.so/bloom/composer-loader";
import { ComposerPill, type ComposerPanelAddMenuGroup, type ModelPickerModel } from "@oxy.so/bloom/composer-panel";
import { toast } from "@oxy.so/bloom/toast";
import { KeyboardAvoidingView } from "@/lib/keyboard";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useSpeechToText } from "@/lib/hooks/use-speech-to-text";
import { ComposerAttachmentStrip } from "./attachment-strip";
import { useComposerPasteTarget } from "./drop-zone";
import { releaseRemovedAttachment, useAttachmentIntake } from "./use-attachment-intake";
import type { Attachment } from "./types";

/**
 * Alia's composer is Bloom's AI Chat template composer:
 *
 *     <ComposerLoader active={working}>
 *       <ComposerPill surface={false} glass={working} busy={working} onStop … />
 *     </ComposerLoader>
 *
 * The mic is the pill's own: pressing it records, pressing it again
 * transcribes into the draft. The attachment strip shows only while a file is
 * attached; the pill has no slot for one yet (`docs/bloom-template-pending.mdx`).
 */
const EMPTY_ADD_MENU: readonly ComposerPanelAddMenuGroup[] = [];

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
  models?: readonly ModelPickerModel[];
  model?: string;
  onModelChange?: (modelId: string) => void;
  effortLevels?: readonly string[];
  effort?: number | null;
  onEffortChange?: (effort: number) => void;
  addMenu?: readonly ComposerPanelAddMenuGroup[];
  onAddMenuSelect?: (rowId: string) => void;
  attachments?: readonly Attachment[];
  onAddAttachment?: (attachment: Attachment) => void;
  onRemoveAttachment?: (id: string) => void;
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
  disableKeyboardAvoidance = false,
}: ComposerProps) {
  const { t } = useTranslation();
  // Paste is a DOM gesture on a DOM node; the pill publishes no ref to one.
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
      voice: t("composer.voice"),
      send: t("composer.send"),
      stop: t("composer.stop"),
      effortAuto: t("effort.levels.default"),
    }),
    [t],
  );

  const host = (
    <View id={hostId}>
      <ComposerAttachmentStrip attachments={attachments} onRemove={removeAttachment} intake={intake} />
      <ComposerLoader active={busy}>
        <ComposerPill
          surface={false}
          glass={busy}
          value={value}
          onValueChange={onValueChange}
          onSubmit={() => onSubmit()}
          busy={busy}
          onStop={onStop}
          disabled={disabled || intake.isBusy || !hasContent}
          placeholder={placeholder}
          addMenu={addMenu ?? EMPTY_ADD_MENU}
          onAddMenuSelect={onAddMenuSelect}
          models={models}
          model={model}
          onModelChange={onModelChange}
          effortLevels={effortLevels}
          effort={effort}
          onEffortChange={onEffortChange}
          listening={stt.isRecording}
          onListeningChange={(next) => void handleListeningChange(next)}
          labels={labels}
        />
      </ComposerLoader>
    </View>
  );

  return disableKeyboardAvoidance ? host : <KeyboardAvoidingView behavior="padding">{host}</KeyboardAvoidingView>;
}
