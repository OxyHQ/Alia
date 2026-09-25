import { useComposerAddMenu } from '@/components/chat/composer/add-menu';
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
import { useStore } from '@/lib/stores/global-store';
import { useModelStore } from '@/lib/stores/model-store';
import { useUIStore } from '@/lib/stores/ui-store';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useMemo, useState } from 'react';

/**
 * Alia's composer, configured once for every screen that asks Alia something:
 * the chat, Automations, and the screens that create an agent or a skill.
 *
 * It returns the props the shared `Composer` (Bloom's `ComposerPanel`) takes
 * beyond the draft itself — the model picker and its effort, the mode
 * selector, the add menu, the attachments — plus the per-turn choices a send
 * carries (connector and skills), so every screen offers the same controls
 * and they mean the same thing.
 */
export interface AliaComposerOptions {
  /** A turn is streaming or the composer is closed: nothing may be attached. */
  locked?: boolean;
  /** Offer ghost mode: only before anything in the conversation is saved. */
  offerGhost?: boolean;
  /**
   * The model this composer sends with, when the screen keeps its own (a
   * conversation remembers its model). Defaults to the app's selection.
   */
  selectedModel?: string | null;
  onModelChange?: (model: string | null) => void;
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
  locked = false,
  offerGhost = false,
  selectedModel: modelOverride,
  onModelChange: onModelOverride,
}: AliaComposerOptions = {}) {
  const { t } = useTranslation();
  const attachments = useStore((state) => state.attachments);
  const addAttachment = useStore((state) => state.addAttachment);
  const removeAttachment = useStore((state) => state.removeAttachment);
  const selectedModel = useModelStore((s) => s.selectedModel);
  const setSelectedModel = useModelStore((s) => s.setSelectedModel);
  const webSearch = useModelStore((s) => s.webSearch);
  const setWebSearch = useModelStore((s) => s.setWebSearch);
  const { active: modeActive, toggle: toggleMode } = useCapabilityModes();
  const { installed } = useMcpServers();
  const { data: installedSkills = [] } = useInstalledSkills();

  /**
   * The connector and the skills chosen for the NEXT message. Per turn:
   * choosing none is the normal case, since Alia can load a skill on its own
   * when a request matches; this is for saying "use this one" out loud.
   */
  const [connectorId, setConnectorId] = useState<string | null>(null);
  const [skillNames, setSkillNames] = useState<string[]>([]);
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

  // The real models, grouped by publisher, as Bloom's model picker takes them
  // (`model-lineup.ts`). A screen that keeps its own model passes it; `null`
  // there, as in the store, is the server's default.
  const lineup = useComposerLineup(
    modelOverride !== undefined ? modelOverride : selectedModel,
    onModelOverride ?? setSelectedModel,
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
    pinModel: lineup.current === null
      ? null
      : { name: lineup.current.name, pinned: lineup.current.pinned, onToggle: lineup.togglePinned },
    turnSelection,
    onToggleSkill: (name: string) => setSkillNames((current) => toggleSkillName(current, name)),
    onToggleConnector: (id: string) => setConnectorId((current) => toggleConnectorId(current, id)),
  });

  /**
   * The mode selector: how Alia works on this turn — answering, or working
   * through a longer task as an agent. Deep research is not a mode: it is a
   * tool the turn may use, switched on in the add menu, and it runs on the
   * model the picker shows. The plan gate and the toasts stay in `toggleMode`.
   */
  const modes = useMemo(
    () => [
      { id: 'chat', label: t('composer.modeChat'), description: t('composer.modeChatDescription'), icon: RiChat3Line },
      { id: 'agent', label: t('modes.agentLabel'), description: t('composer.agentDescription'), icon: RiRobot2Line },
    ],
    [t],
  );
  const mode = modeActive.agent ? 'agent' : 'chat';
  const onModeChange = useCallback(
    (next: string) => {
      if ((next === 'agent') !== modeActive.agent) toggleMode('agent');
    },
    [modeActive.agent, toggleMode],
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

  /** Put a turn's choices back (a draft handed over, or a send that failed). */
  const restoreTurn = useCallback((next: SendOptions) => {
    setConnectorId(next.mcpServerId ?? null);
    setSkillNames(next.skillNames ?? []);
  }, []);
  /** Forget the turn's choices once it has been sent. */
  const clearTurn = useCallback(() => {
    setConnectorId(null);
    setSkillNames([]);
  }, []);

  return { props, attachments, turnOptions, restoreTurn, clearTurn };
}
