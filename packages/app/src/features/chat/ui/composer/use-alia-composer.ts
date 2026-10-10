import { useComposerAddMenu } from '@/features/chat/ui/composer/add-menu';
import type { Attachment } from '@/features/chat/ui/composer/types';
import type { ComposerProps } from '@/features/chat/ui/composer/composer';
import { usePowerLevelSelector } from '@/features/chat/ui/composer/power-level-options';
import {
  buildTurnSelection,
  toggleConnectorId,
  toggleSkillName,
} from '@/features/chat/model/turn-selection';
import { useCapabilityModes } from '@/features/chat/runtime/use-capability-modes';
import { useMcpServers } from '@/features/connections/runtime/use-mcp-servers';
import { useInstalledSkills } from '@/features/skills/runtime/use-skills';
import type { SendOptions } from '@/shared/contracts/chat-turn';
import { useTranslation } from '@/shared/i18n/use-translation';
import {
  useComposerDraft,
  useComposerDraftStore,
  useDraftAddress,
  type DraftTarget,
} from '@/features/chat/runtime/composer-draft-store';
import { useModelStore } from '@/features/chat/runtime/model-store';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useMemo } from 'react';

/**
 * Alia's composer, configured once for every screen that asks Alia something:
 * the chat, Automations, and the screens that create an agent or a skill.
 *
 * It returns the props the shared `Composer` (Bloom's `ComposerPanel`) takes
 * beyond the draft itself — the power-level selector (the panel's mode pill),
 * the add menu, the attachments — plus the per-turn choices a send
 * carries (connector and skills), so every screen offers the same controls
 * and they mean the same thing.
 *
 * What the composer holds before it is sent — text, attachments, connector,
 * skills — is the draft of `draft` in `src/features/chat/runtime/composer-draft-store.ts`,
 * under the signed-in account. Nothing of it is kept here.
 */
export interface AliaComposerOptions {
  /**
   * Whose draft this composer edits: the conversation's id, `null` for the
   * new-chat screen, or a `surface:` name. Two composers never share one.
   */
  draft: DraftTarget;
  /** A turn is streaming or the composer is closed: nothing may be attached. */
  locked?: boolean;
  /**
   * The surface sends a prompt string and nothing else (creating an agent or
   * a skill: both generate endpoints read the prompt and nothing more). Every
   * control whose value such a send would ignore goes — the add menu with its
   * files, search, skills and connectors — and with no attachment props the
   * composer takes no paste or drop either.
   *
   * The power-level selector stays only when the screen keeps its own level
   * (`onModelChange`): creating an agent stores the one picked as the new
   * agent's level, so there the choice is carried. Without it, it goes too.
   */
  promptOnly?: boolean;
  /** Offer ghost mode: only before anything in the conversation is saved. */
  offerGhost?: boolean;
  /**
   * The power level this composer sends with, when the screen keeps its own
   * (a conversation remembers its level). Defaults to the app's selection.
   */
  selectedModel?: string | null;
  onModelChange?: (level: string) => void;
}

export type AliaComposerProps = Pick<
  ComposerProps,
  | 'attachments'
  | 'onAddAttachment'
  | 'onRemoveAttachment'
  | 'modes'
  | 'mode'
  | 'onModeChange'
  | 'addMenu'
  | 'onAddMenuSelect'
>;

export function useAliaComposer({
  draft: target,
  locked = false,
  promptOnly = false,
  offerGhost = false,
  selectedModel: modelOverride,
  onModelChange: onModelOverride,
}: AliaComposerOptions) {
  const { t } = useTranslation();
  const draft = useComposerDraft(target);
  const address = useDraftAddress(target);
  const { attachments, mcpServerId: connectorId, skillNames } = draft;
  const addAttachment = useCallback(
    (attachment: Attachment) => useComposerDraftStore.getState().addAttachment(address, attachment),
    [address],
  );
  const removeAttachment = useCallback(
    (id: string) => useComposerDraftStore.getState().removeAttachment(address, id),
    [address],
  );
  const setText = useCallback(
    (text: string) => useComposerDraftStore.getState().setText(address, text),
    [address],
  );
  const selectedLevel = useModelStore((s) => s.selectedLevel);
  const setSelectedLevel = useModelStore((s) => s.setSelectedLevel);
  const webSearch = useModelStore((s) => s.webSearch);
  const setWebSearch = useModelStore((s) => s.setWebSearch);
  const { active: modeActive, toggle: toggleMode } = useCapabilityModes();
  const { installed } = useMcpServers();
  const { data: installedSkills = [] } = useInstalledSkills();

  /**
   * The connector and the skills chosen for the NEXT message, kept in the
   * draft. Per turn: choosing none is the normal case, since Alia can load a
   * skill on its own when a request matches; this is for saying "use this
   * one" out loud.
   */
  const updateTurn = useComposerDraftStore((state) => state.updateTurn);
  const turnSelection = useMemo(
    () =>
      buildTurnSelection({
        installedSkills,
        installedConnectors: installed,
        selectedSkillNames: skillNames,
        selectedConnectorId: connectorId,
      }),
    [installedSkills, installed, skillNames, connectorId],
  );

  // Withholds three tools rather than rewording a prompt: an off switch the
  // model cannot overrule (see `src/features/chat/runtime/model-store.ts`).
  const toggleWebSearch = useCallback(() => {
    const next = !webSearch;
    setWebSearch(next);
    toast.info(next ? t('modes.searchOn') : t('modes.searchOff'));
  }, [webSearch, setWebSearch, t]);

  // The power levels (and the person's own device models), as Bloom's mode
  // pill takes them (`power-level-options.ts`). A screen that keeps its own
  // level passes it; `null` there is `auto`.
  const levels = usePowerLevelSelector(
    modelOverride !== undefined ? modelOverride : selectedLevel,
    onModelOverride ?? setSelectedLevel,
    // A prompt-only surface stores the level on something Alia runs (a new
    // agent), which no device of this person's can serve.
    { devices: !promptOnly },
  );

  const addMenu = useComposerAddMenu({
    addAttachment,
    canAttach: !locked,
    modes: modeActive,
    toggleMode,
    webSearch,
    onToggleWebSearch: toggleWebSearch,
    onOpenCanvas: () => useUIStore.getState().setRightPanel('canvas'),
    offerGhost,
    turnSelection,
    onToggleSkill: (name: string) =>
      updateTurn(address, (turn) => ({
        ...turn,
        skillNames: toggleSkillName(turn.skillNames, name),
      })),
    onToggleConnector: (id: string) =>
      updateTurn(address, (turn) => ({
        ...turn,
        mcpServerId: toggleConnectorId(turn.mcpServerId, id),
      })),
  });

  /**
   * The mode selector is the power level: how much power this turn gets.
   * Working as an agent and deep research are capabilities the turn may use,
   * switched on in the add menu; they run at the level the pill shows.
   */
  const props: AliaComposerProps = promptOnly
    ? onModelOverride
      ? { modes: levels.modes, mode: levels.mode, onModeChange: levels.onModeChange }
      : {}
    : {
        attachments,
        onAddAttachment: addAttachment,
        onRemoveAttachment: removeAttachment,
        modes: levels.modes,
        mode: levels.mode,
        onModeChange: levels.onModeChange,
        addMenu: addMenu.groups,
        onAddMenuSelect: addMenu.onSelect,
      };

  /** What a send carries beyond the text. */
  const turnOptions: SendOptions = { mcpServerId: connectorId, skillNames };

  /**
   * Empty the draft for a send. Its attachments are not released — the send
   * still needs them, and a failed one hands them back to the draft.
   */
  const clearDraft = useCallback(() => useComposerDraftStore.getState().clear(address), [address]);

  return { props, text: draft.text, setText, attachments, turnOptions, address, clearDraft };
}
