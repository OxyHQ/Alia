import { useComposerAddMenu } from '@/components/chat/composer/add-menu';
import type { Attachment } from '@/components/chat/composer/types';
import type { ComposerProps } from '@/components/chat/composer/composer';
import { useComposerLineup } from '@/components/chat/composer/model-lineup';
import {
  buildTurnSelection,
  toggleConnectorId,
  toggleSkillName,
} from '@/lib/chat/turn-selection';
import { useCapabilityModes } from '@/lib/chat/use-capability-modes';
import { useMcpServers } from '@/lib/hooks/use-mcp-servers';
import { useInstalledSkills } from '@/lib/hooks/use-skills';
import type { SendOptions } from '@/lib/hooks/use-streaming-chat';
import { useTranslation } from '@/lib/hooks/use-translation';
import {
  useComposerDraft,
  useComposerDraftStore,
  useDraftAddress,
  type DraftTarget,
} from '@/lib/stores/composer-draft-store';
import { useModelStore } from '@/lib/stores/model-store';
import { useUIStore } from '@/lib/stores/ui-store';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useMemo } from 'react';

/**
 * Alia's composer, configured once for every screen that asks Alia something:
 * the chat, Automations, and the screens that create an agent or a skill.
 *
 * It returns the props the shared `Composer` (Bloom's `ComposerPanel`) takes
 * beyond the draft itself — the model picker and its effort, the mode
 * selector, the add menu, the attachments — plus the per-turn choices a send
 * carries (connector and skills), so every screen offers the same controls
 * and they mean the same thing.
 *
 * What the composer holds before it is sent — text, attachments, connector,
 * skills — is the draft of `draft` in `lib/stores/composer-draft-store.ts`,
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
  /** Offer ghost mode: only before anything in the conversation is saved. */
  offerGhost?: boolean;
  /**
   * The model this composer sends with, when the screen keeps its own (a
   * conversation remembers its model). Defaults to the app's selection.
   */
  selectedModel?: string;
  onModelChange?: (model: string) => void;
}

export type AliaComposerProps = Pick<
  ComposerProps,
  | 'attachments'
  | 'onAddAttachment'
  | 'onRemoveAttachment'
  | 'providers'
  | 'model'
  | 'onModelChange'
  | 'effortLevels'
  | 'effort'
  | 'onEffortChange'
  | 'modes'
  | 'mode'
  | 'onModeChange'
  | 'addMenu'
  | 'onAddMenuSelect'
>;

export function useAliaComposer({
  draft: target,
  locked = false,
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
  const selectedModel = useModelStore((s) => s.selectedModel);
  const setSelectedModel = useModelStore((s) => s.setSelectedModel);
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
  // model cannot overrule (see `lib/stores/model-store.ts`).
  const toggleWebSearch = useCallback(() => {
    const next = !webSearch;
    setWebSearch(next);
    toast.info(next ? t('modes.searchOn') : t('modes.searchOff'));
  }, [webSearch, setWebSearch, t]);

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
      updateTurn(address, (turn) => ({ ...turn, skillNames: toggleSkillName(turn.skillNames, name) })),
    onToggleConnector: (id: string) =>
      updateTurn(address, (turn) => ({ ...turn, mcpServerId: toggleConnectorId(turn.mcpServerId, id) })),
  });

  // The catalogue as Bloom's model picker takes it, with the plan gate kept
  // as an intercepted change (`model-lineup.ts`).
  const lineup = useComposerLineup(
    modelOverride ?? selectedModel,
    onModelOverride ?? setSelectedModel,
  );

  /**
   * The mode selector: how Alia works on this turn. The capability flags that
   * already existed (agent, deep research), exclusive here because a turn is
   * one or the other; the plan gate and the toasts stay in `toggleMode`.
   */
  const modes = useMemo(
    () => [
      { id: 'chat', label: t('composer.modeChat'), description: t('composer.modeChatDescription'), icon: RiChat3Line },
      { id: 'agent', label: t('modes.agentLabel'), description: t('composer.agentDescription'), icon: RiRobot2Line },
      { id: 'research', label: t('modes.deepResearchLabel'), description: t('composer.deepResearchDescription'), icon: RiSearchLine },
    ],
    [t],
  );
  const mode = modeActive.agent ? 'agent' : modeActive.deepResearch ? 'research' : 'chat';
  const onModeChange = useCallback(
    (next: string) => {
      if (next === mode) return;
      if (modeActive.agent) toggleMode('agent');
      if (modeActive.deepResearch) toggleMode('deepResearch');
      if (next === 'agent') toggleMode('agent');
      if (next === 'research') toggleMode('deepResearch');
    },
    [mode, modeActive, toggleMode],
  );

  const props: AliaComposerProps = {
    attachments,
    onAddAttachment: addAttachment,
    onRemoveAttachment: removeAttachment,
    providers: lineup.providers,
    model: lineup.model,
    onModelChange: lineup.onModelChange,
    effortLevels: lineup.effortLevels,
    effort: lineup.effort,
    onEffortChange: lineup.onEffortChange,
    modes,
    mode,
    onModeChange,
    addMenu: addMenu.groups,
    onAddMenuSelect: addMenu.onSelect,
  };

  /** What a send carries beyond the text. */
  const turnOptions: SendOptions = { mcpServerId: connectorId, skillNames };

  /**
   * Empty the draft for a send. Its attachments are not released — the send
   * still needs them, and a failed one hands them back to the draft.
   */
  const clearDraft = useCallback(
    () => useComposerDraftStore.getState().clear(address),
    [address],
  );

  return { props, text: draft.text, setText, attachments, turnOptions, address, clearDraft };
}
