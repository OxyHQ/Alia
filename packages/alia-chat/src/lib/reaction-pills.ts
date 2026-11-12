import type { MessageReactionEntry } from '../runtime/types';

export interface ReactionPillData {
  emoji: string;
  selected: boolean;
  authors: MessageReactionEntry['author'][];
}

/** Pending human intent replaces only that author's projection; agent feedback is independent. */
export function reactionPills(
  ownReactions: readonly string[],
  entries: readonly MessageReactionEntry[] = [],
  viewerId?: string,
): ReactionPillData[] {
  const groups = new Map<string, ReactionPillData>();
  const add = (emoji: string, author: MessageReactionEntry['author'], selected: boolean) => {
    const group = groups.get(emoji) ?? { emoji, selected: false, authors: [] };
    if (!group.authors.some((held) => held.kind === author.kind && held.id === author.id)) {
      group.authors.push(author);
    }
    group.selected ||= selected;
    groups.set(emoji, group);
  };
  const otherOwner = entries.some(
    (entry) => entry.author.kind === 'user' && entry.author.id !== viewerId,
  );
  for (const entry of entries) {
    if (entry.author.kind === 'agent' || (otherOwner && entry.author.id !== viewerId)) {
      add(entry.emoji, entry.author, false);
    }
  }
  if (!otherOwner) {
    for (const emoji of ownReactions) add(emoji, { kind: 'user', id: viewerId ?? '' }, true);
  }
  return [...groups.values()];
}
