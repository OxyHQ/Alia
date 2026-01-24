import type { Conversation } from '../hooks/use-conversations';

export type DateGroup =
  | 'Today'
  | 'Yesterday'
  | 'Previous 7 Days'
  | 'Previous 30 Days'
  | 'Previous 3 Months'
  | 'Previous Year'
  | 'Older';

export interface GroupedConversations {
  group: DateGroup;
  conversations: Conversation[];
}

/**
 * Get the date group for a given date (ChatGPT-style grouping)
 */
export function getDateGroup(date: Date): DateGroup {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const conversationDate = new Date(date);
  const daysDiff = Math.floor((today.getTime() - conversationDate.getTime()) / (1000 * 60 * 60 * 24));

  if (daysDiff === 0) {
    return 'Today';
  } else if (daysDiff === 1) {
    return 'Yesterday';
  } else if (daysDiff <= 7) {
    return 'Previous 7 Days';
  } else if (daysDiff <= 30) {
    return 'Previous 30 Days';
  } else if (daysDiff <= 90) {
    return 'Previous 3 Months';
  } else if (daysDiff <= 365) {
    return 'Previous Year';
  } else {
    return 'Older';
  }
}

/**
 * Group conversations by date (ChatGPT-style)
 */
export function groupConversationsByDate(conversations: Conversation[]): GroupedConversations[] {
  // Map to group conversations
  const groupMap = new Map<DateGroup, Conversation[]>();

  // Initialize all groups
  const allGroups: DateGroup[] = [
    'Today',
    'Yesterday',
    'Previous 7 Days',
    'Previous 30 Days',
    'Previous 3 Months',
    'Previous Year',
    'Older',
  ];

  allGroups.forEach(group => groupMap.set(group, []));

  // Group conversations
  conversations.forEach(conversation => {
    const group = getDateGroup(conversation.updatedAt);
    groupMap.get(group)?.push(conversation);
  });

  // Convert to array and filter empty groups
  return allGroups
    .map(group => ({
      group,
      conversations: groupMap.get(group) || [],
    }))
    .filter(item => item.conversations.length > 0);
}

/**
 * Flatten grouped conversations for FlashList
 * Returns array with section headers and conversations
 */
export interface ConversationListItem {
  type: 'header' | 'conversation';
  group?: DateGroup;
  conversation?: Conversation;
  id: string;
}

export function flattenGroupedConversations(grouped: GroupedConversations[]): ConversationListItem[] {
  const result: ConversationListItem[] = [];

  grouped.forEach(({ group, conversations }) => {
    // Add header
    result.push({
      type: 'header',
      group,
      id: `header-${group}`,
    });

    // Add conversations
    conversations.forEach(conversation => {
      result.push({
        type: 'conversation',
        conversation,
        id: conversation.id,
      });
    });
  });

  return result;
}
