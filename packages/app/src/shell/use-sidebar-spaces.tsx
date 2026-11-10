import {
  agentsOutsideSpaces,
  buildSpaceSections,
  planSpaces,
  type SpacePlan,
} from '@/features/spaces/model/space-rows';
import { useSpaceMutations, useSpaces } from '@/features/spaces/runtime/use-spaces';
import { useSpacesOpenStore } from '@/features/spaces/runtime/spaces-open-store';
import {
  SpaceDialog,
  spaceFailureMessage,
  type SpaceDialogState,
  type SpaceDialogValues,
} from '@/features/spaces/ui/space-dialog';
import { AgentSpaceActions, SpaceActions } from '@/shell/sidebar-space-menus';
import { useStore } from '@/features/chat/runtime/global-store';
import type { Agent } from '@/shared/contracts/agents';
import type { Space } from '@/shared/contracts/spaces';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Conversation } from '@alia.onl/sdk/model';
import type { SidebarTree, SidebarTreeItem } from '@oxy.so/bloom/sidebar';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useRouter } from 'expo-router';
import React from 'react';

/**
 * The sidebar's half of Spaces (ADR 0028): the spaces, what the person can do to them, and the
 * dialog those actions open. The sidebar gives it the agents and conversations it already holds and
 * the two row builders it draws a contact and a room with; it gives back the section, the agent
 * row's menu, the "New space" entry and the dialog.
 */
export function useSidebarSpaces({
  enabled,
  agents,
}: {
  /** Signed in: a visitor has no spaces. */
  enabled: boolean;
  agents: readonly Agent[] | undefined;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { data, isLoading } = useSpaces();
  const { createSpace, updateSpace, deleteSpace, moveAgent, removeAgent } = useSpaceMutations();
  const closedIds = useSpacesOpenStore((state) => state.closedIds);
  const setSpaceOpen = useSpacesOpenStore((state) => state.setSpaceOpen);
  const [dialog, setDialog] = React.useState<SpaceDialogState>(null);

  const spaces = React.useMemo<Space[]>(() => (enabled ? (data ?? []) : []), [enabled, data]);

  const openCreate = React.useCallback(() => setDialog({ mode: 'create' }), []);
  const rename = React.useCallback((space: Space) => setDialog({ mode: 'rename', space }), []);
  const editBrief = React.useCallback((space: Space) => setDialog({ mode: 'brief', space }), []);
  const addAgents = React.useCallback(
    (space: Space) => setDialog({ mode: 'addAgents', space }),
    [],
  );

  const askDelete = React.useCallback(
    async (space: Space) => {
      const ok = await confirm({
        title: t('spaces.deleteTitle'),
        description: t('spaces.deleteDescription', { name: space.name }),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await deleteSpace.mutateAsync(space.id);
      } catch {
        toast.error(t('spaces.deleteFailed'));
        return;
      }
      // Its room goes with it: leave it if it is the open conversation.
      if (useStore.getState().chatId?.id === space.conversationId) router.replace('/(app)');
    },
    [t, deleteSpace, router],
  );

  /** Put an agent in a space, or (`null`) take it out of the one it is in. */
  const move = React.useCallback(
    async (agent: Agent, spaceId: string | null) => {
      const from = agent.spaceId ?? null;
      if (from === spaceId) return;
      try {
        if (spaceId === null) {
          await removeAgent.mutateAsync({ spaceId: from as string, agentId: agent._id });
        } else {
          await moveAgent.mutateAsync({ spaceId, agentId: agent._id });
        }
      } catch (error) {
        toast.error(spaceFailureMessage(error, t));
      }
    },
    [t, moveAgent, removeAgent],
  );

  const submit = React.useCallback(
    async (state: NonNullable<SpaceDialogState>, values: SpaceDialogValues) => {
      switch (state.mode) {
        case 'create':
          await createSpace.mutateAsync({ name: values.name as string, ...values });
          return;
        case 'rename':
        case 'brief':
          await updateSpace.mutateAsync({ id: state.space.id, ...values });
          return;
        case 'addAgents':
          // One request per agent, in the order picked; the first refusal stops the rest.
          for (const agentId of values.agentIds ?? []) {
            await moveAgent.mutateAsync({ spaceId: state.space.id, agentId });
          }
          return;
      }
    },
    [createSpace, updateSpace, moveAgent],
  );

  /** The ⋯ menu of an agent row: shown for a member, and for any agent once a space exists. */
  const agentMenu = React.useCallback(
    (agent: Agent) =>
      enabled && (agent.spaceId || spaces.length > 0) ? (
        <AgentSpaceActions agent={agent} spaces={spaces} onMove={move} />
      ) : undefined,
    [enabled, spaces, move],
  );

  /** One section per space; none when the person has no space (or a search finds none). */
  const buildSections = React.useCallback(
    ({
      conversations,
      query,
      agentRow,
      roomRow,
    }: {
      conversations: readonly Conversation[];
      query: string;
      agentRow: (agent: Agent) => SidebarTreeItem;
      roomRow: (plan: SpacePlan) => SidebarTreeItem;
    }): SidebarTree[] =>
      spaces.length === 0
        ? []
        : buildSpaceSections({
            plans: planSpaces(spaces, agents ?? [], conversations),
            query,
            closedIds,
            onOpenChange: (spaceId, open) => void setSpaceOpen(spaceId, open),
            sectionActions: (space) => (
              <SpaceActions
                space={space}
                onRename={rename}
                onEditBrief={editBrief}
                onAddAgent={addAgents}
                onDelete={askDelete}
              />
            ),
            agentRow,
            roomRow,
            addAgentsRow: (space) => ({
              key: `space-add:${space.id}`,
              label: t('spaces.addAgents'),
              onPress: () => addAgents(space),
            }),
          }),
    [spaces, agents, t, closedIds, setSpaceOpen, rename, editBrief, addAgents, askDelete],
  );

  const candidates = React.useMemo(() => agentsOutsideSpaces(agents ?? []), [agents]);
  const dialogs = (
    <SpaceDialog
      state={dialog}
      candidates={candidates}
      onClose={() => setDialog(null)}
      onSubmit={submit}
    />
  );

  return {
    spaces,
    /** The first read of the spaces is on its way and nothing is cached. */
    isLoading: enabled && isLoading,
    openCreate,
    agentMenu,
    buildSections,
    dialogs,
  };
}
