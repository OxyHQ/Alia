import { agentDisplayName } from '@/features/agents/model/identity';
import type { Agent } from '@/shared/contracts/agents';
import { SPACE_MAX_AGENTS, type Space } from '@/shared/contracts/spaces';
import { useTranslation } from '@/shared/i18n/use-translation';
import { MoreTrigger } from '@/shell/sidebar-menus';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import React from 'react';

/** The radio value for "in no space"; space ids are never empty. */
const NONE = '';

/** A space folder's menu: rename, edit the brief, add an agent, delete. */
export const SpaceActions = React.memo(function SpaceActions({
  space,
  onRename,
  onEditBrief,
  onAddAgent,
  onDelete,
}: {
  space: Space;
  onRename: (space: Space) => void;
  onEditBrief: (space: Space) => void;
  onAddAgent: (space: Space) => void;
  onDelete: (space: Space) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <MoreTrigger label={t('spaces.options', { name: space.name })} />
      <DropdownMenuContent minWidth={190}>
        <DropdownMenuItem onPress={() => onRename(space)}>{t('spaces.rename')}</DropdownMenuItem>
        <DropdownMenuItem onPress={() => onEditBrief(space)}>
          {t('spaces.editBrief')}
        </DropdownMenuItem>
        {space.memberAgentIds.length < SPACE_MAX_AGENTS ? (
          <DropdownMenuItem onPress={() => onAddAgent(space)}>
            {t('spaces.addAgent')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" onPress={() => onDelete(space)}>
          {t('spaces.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/**
 * An agent row's menu: move it to a space, or take it out of the one it is in. Moving to another
 * space leaves the previous one (the API does it in one request), so there is one radio group.
 */
export const AgentSpaceActions = React.memo(function AgentSpaceActions({
  agent,
  spaces,
  onMove,
}: {
  agent: Agent;
  spaces: readonly Space[];
  /** `null` takes the agent out of its space. */
  onMove: (agent: Agent, spaceId: string | null) => void;
}) {
  const { t } = useTranslation();
  const name = agentDisplayName(agent);
  return (
    <DropdownMenu>
      <MoreTrigger label={t('spaces.agentOptions', { name })} />
      <DropdownMenuContent minWidth={200}>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{t('spaces.moveToSpace')}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent side="right" align="start">
            <DropdownMenuRadioGroup
              value={agent.spaceId ?? NONE}
              onValueChange={(value) => onMove(agent, value || null)}
            >
              <DropdownMenuRadioItem value={NONE}>{t('spaces.noSpace')}</DropdownMenuRadioItem>
              {spaces.map((space) => (
                <DropdownMenuRadioItem key={space.id} value={space.id}>
                  {space.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
