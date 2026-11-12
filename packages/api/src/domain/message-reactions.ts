/**
 * Reactions to a message: the emoji a person puts under it, as a chat bubble shows them.
 *
 * A leaf module: it imports nothing (`db/__tests__/schemaModelIndependence.test.ts`).
 */

/** How many different emoji one person can leave on one message. */
export const MAX_REACTIONS_PER_MESSAGE = 6;
/** The longest a reaction may be: a flag, a family or a skin-toned gesture is several code points. */
const MAX_REACTION_LENGTH = 16;

export interface AgentReactionEntry {
  emoji: string;
  author: { kind: 'agent'; id: string; name: string };
}
export type MessageReactionEntry =
  | AgentReactionEntry
  | { emoji: string; author: { kind: 'user'; id: string } };

/** Human selection remains separate so old clients never toggle another author's emoji. */
export function attributedReactions(
  userId: string,
  reactions: readonly string[],
  agentReactions: readonly AgentReactionEntry[] = [],
): MessageReactionEntry[] {
  return [
    ...reactions.map((emoji) => ({ emoji, author: { kind: 'user' as const, id: userId } })),
    ...agentReactions,
  ];
}

/** One or more pictographs (with their joiners, tones and variation selectors), and nothing else. */
const EMOJI =
  /^(?:[0-9#*]\ufe0f?\u20e3|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|\p{Regional_Indicator})+$/u;

/** A reaction as a client sends it: a short, emoji-only string, or `null` when it is not one. */
export function parseReaction(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const emoji = value.trim();
  if (emoji === '' || emoji.length > MAX_REACTION_LENGTH || !EMOJI.test(emoji)) return null;
  return emoji;
}

/**
 * The reactions after the person toggles `emoji`: removed when it was there, else added, unless
 * they already hold the most a message takes (then the toggle changes nothing).
 */
export function toggleReaction(current: readonly string[], emoji: string): string[] {
  if (current.includes(emoji)) return current.filter((held) => held !== emoji);
  if (current.length >= MAX_REACTIONS_PER_MESSAGE) return [...current];
  return [...current, emoji];
}
