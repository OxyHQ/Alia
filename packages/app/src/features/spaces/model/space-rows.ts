import { agentIdentityMatches } from '@/features/agents/model/identity';
import type { Agent } from '@/shared/contracts/agents';
import type { Space } from '@/shared/contracts/spaces';
import type { Conversation } from '@alia.onl/sdk/model';
import type { SidebarTree, SidebarTreeItem } from '@oxy.so/bloom/sidebar';
import type { ReactNode } from 'react';

/**
 * The sidebar's Spaces (ADR 0028), as data: who is outside every space and what each folder holds.
 * Pure, so the rules that break in silence (an agent in two places, a room among Alia's chats) are
 * tested without a screen.
 */

/** The tree key of a space's section. */
export const SPACE_KEY = 'space:';
/** The tree key of the muted row an empty space shows ("Add agents"). */
export const SPACE_ADD_KEY = 'space-add:';

/** The agents the flat Agents list shows: the ones in no space (those are listed under their space). */
export const agentsOutsideSpaces = (agents: readonly Agent[]): Agent[] =>
  agents.filter((agent) => !agent.spaceId);

/**
 * The conversations the sidebar files as group chats and as Alia's chats: everything but a space's
 * ROOM (`spaceId` set), which is listed inside its space and nowhere else. The wire carries an
 * explicit `null` on every ordinary conversation, and an older answer carries nothing.
 */
export const conversationsOutsideSpaces = (
  conversations: readonly Conversation[],
): Conversation[] => conversations.filter((conversation) => !conversation.spaceId);

/** What one space folder holds. */
export interface SpacePlan {
  space: Space;
  /** The space's agents, in the space's order; an id the person's agent list lacks is left out. */
  members: Agent[];
  /** The room's conversation when the list holds it (its last line and time), else `undefined`. */
  room: Conversation | undefined;
  /** An empty space has no room to open (ADR 0028 §4): the row is there only with a member. */
  showRoom: boolean;
}

export function planSpaces(
  spaces: readonly Space[],
  agents: readonly Agent[],
  conversations: readonly Conversation[],
): SpacePlan[] {
  const agentsById = new Map(agents.map((agent) => [agent._id, agent]));
  const roomsById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  return spaces.map((space) => ({
    space,
    members: space.memberAgentIds.flatMap((id) => {
      const agent = agentsById.get(id);
      return agent ? [agent] : [];
    }),
    room: roomsById.get(space.conversationId),
    showRoom: space.memberAgentIds.length > 0,
  }));
}

/**
 * The Spaces, one SECTION each (not one folder inside a shared section): a section's rows are the same
 * rich rows as the Agents list — the agent's picture and its last line — which Bloom does not draw for a
 * folder's rows (label and chip only). Each is collapsible, with its menu beside the name, its room first
 * ("General") and then one row per member, built by the same row builder as the flat Agents list. Empty
 * when the person has no space, and for a space a search leaves nothing in.
 *
 * A search keeps a space whose NAME matches whole, and otherwise only the members that match; an empty
 * space is found by its name alone.
 */
export function buildSpaceSections({
  plans,
  query,
  closedIds,
  onOpenChange,
  sectionActions,
  agentRow,
  roomRow,
  addAgentsRow,
}: {
  plans: readonly SpacePlan[];
  query: string;
  closedIds: readonly string[];
  onOpenChange: (spaceId: string, open: boolean) => void;
  sectionActions: (space: Space) => ReactNode;
  agentRow: (agent: Agent) => SidebarTreeItem;
  roomRow: (plan: SpacePlan) => SidebarTreeItem;
  addAgentsRow: (space: Space) => SidebarTreeItem;
}): SidebarTree[] {
  const needle = query.trim().toLowerCase();
  return plans.flatMap(({ space, members, room, showRoom }): SidebarTree[] => {
    const nameMatches = !needle || space.name.toLowerCase().includes(needle);
    const shown = nameMatches
      ? members
      : members.filter((agent) => agentIdentityMatches(agent, needle));
    if (!nameMatches && shown.length === 0) return [];
    const items = [
      ...(showRoom && nameMatches ? [roomRow({ space, members, room, showRoom })] : []),
      ...shown.map(agentRow),
      ...(members.length === 0 && space.memberAgentIds.length === 0 ? [addAgentsRow(space)] : []),
    ];
    return [
      {
        key: `${SPACE_KEY}${space.id}`,
        label: space.name,
        collapsible: true,
        open: !closedIds.includes(space.id),
        onOpenChange: (open: boolean) => onOpenChange(space.id, open),
        actions: sectionActions(space),
        items,
      },
    ];
  });
}
