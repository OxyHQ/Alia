/**
 * The rules of a group room, as pure functions (ADR 0025): who is addressed, who speaks next, when a
 * chain must stop, and what a member is told about the room it is in. Nothing here reads a database,
 * a queue or a clock, so every bound that keeps a room affordable is testable on its own.
 */

import type { AgentInfo } from '../../../domain/conversation.js';

// ── Bounds ──

/**
 * How many times one chain may hand the floor from a member to another by `@mention`. A person's
 * message starts the chain at depth 0; each mention-triggered turn is one deeper. Three hand-offs
 * (person, A, B, C, D) is a real exchange between members; past it, two agents that keep
 * mentioning each other are a loop, not a conversation.
 */
export const MAX_MENTION_DEPTH = 3;
/**
 * The most replies one person message may cause in total. Each reply is a paid model turn, so this
 * is the hard cost ceiling of a message: six members answering once plus a handful of hand-offs.
 */
export const MAX_REPLIES_PER_MESSAGE = 12;
/** The most turns (answers, declines and failures) one chain may take: a failure is still work. */
export const MAX_TURNS_PER_MESSAGE = 24;
/** How many members one reply may hand the floor to. The rest of its mentions are only text. */
export const MAX_MENTIONS_PER_REPLY = 2;
/**
 * A room's rate limit across person messages: a person sending messages quickly supersedes chains,
 * but a turn already running is paid for, so the replies a room stores per window are capped.
 */
export const ROOM_REPLY_WINDOW_MS = 10 * 60_000;
export const ROOM_REPLIES_PER_WINDOW = 60;

/**
 * What a member answers to say it has nothing to add. The whole reply, nothing else: it is neither
 * stored nor shown, and it is not an error. Offered only to a member that was handed the floor by
 * another member (a person's own question is always answered).
 */
export const PASS_SENTINEL = '[pass]';

// ── Roster ──

/** A member of the room as the chain carries it: who it is, and the authority its turns run on. */
export interface RoomMember {
  readonly info: AgentInfo;
  /** The Oxy task its turns act under; absent when Oxy could not mint one (no Oxy apps then). */
  readonly oxyTaskId?: string;
}

/** The state a chain carries from one member's turn to the next. */
export interface ChainState {
  /** Members still to speak, in order, not counting the one that just did. */
  readonly pending: readonly string[];
  /** Mention hand-offs so far. */
  readonly depth: number;
  /** Replies stored so far, the one just stored included. */
  readonly replies: number;
  /** Turns taken so far, the one just taken included. */
  readonly turns: number;
  /** The member whose reply is the latest in the room, or `null` when none spoke yet. */
  readonly lastSpeakerId: string | null;
}

export type StopReason = 'reply_cap' | 'turn_cap';

export interface NextTurns {
  /** Who speaks next, in order. Empty ends the chain. */
  readonly queue: readonly string[];
  readonly depth: number;
  readonly stop: StopReason | null;
}

// ── Mentions ──

/** Lower case, accents and diacritics removed, spaces collapsed: what two spellings of a name share. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The words that address one member: its handle, its full name, that name joined, its first name. */
function aliasesOf(info: AgentInfo): string[] {
  const aliases = new Set<string>();
  const handle = normalizeForMatch(info.handle).replace(/^@/, '');
  if (handle !== '') aliases.add(handle);
  const name = normalizeForMatch(info.name);
  if (name !== '') {
    aliases.add(name);
    aliases.add(name.replace(/ /g, ''));
    const first = name.split(' ')[0]!;
    if (first.length >= 2) aliases.add(first);
  }
  return [...aliases];
}

/**
 * The members `text` hands the floor to with `@name` or `@handle`, in the order they appear, each
 * once. Case and accents do not matter (`@NÁDIA` is `@nadia`); `@Nadia Ruiz`, `@NadiaRuiz` and the
 * first name `@Nadia` all reach the member called Nadia Ruiz, unless two members share that word, in
 * which case it reaches neither (a guess would hand the floor to the wrong agent). A speaker never
 * mentions itself and a name that is not a member of the room is only text.
 */
export function parseMentions(
  text: string,
  roster: readonly AgentInfo[],
  options: { readonly exclude?: string } = {},
): string[] {
  const owners = new Map<string, string | null>();
  for (const info of roster) {
    for (const alias of aliasesOf(info)) {
      const owner = owners.get(alias);
      owners.set(alias, owner === undefined || owner === info.id ? info.id : null);
    }
  }
  const aliases = [...owners.entries()]
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([alias]) => alias)
    .sort((a, b) => b.length - a.length);
  if (aliases.length === 0) return [];
  // Longest alias first, so `@nadia ruiz` is not read as `@nadia` followed by a surname.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_@])@(${aliases.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
    'gu',
  );
  const found: string[] = [];
  for (const match of normalizeForMatch(text).matchAll(pattern)) {
    const id = owners.get(match[1]!);
    if (id && id !== options.exclude && !found.includes(id)) found.push(id);
  }
  return found;
}

/**
 * Who answers a person's message: the members it mentions, in the order it mentions them, or, with
 * no mention, every member in the group's order.
 */
export function firstRound(personText: string, roster: readonly AgentInfo[]): string[] {
  const mentioned = parseMentions(personText, roster);
  return mentioned.length > 0 ? mentioned : roster.map((info) => info.id);
}

// ── Chain ──

/**
 * Who speaks after a turn that has just ended, and whether the chain stops.
 *
 * `reply` is what the member stored, or `null` when it declined or failed (a decline hands the floor
 * to nobody; a failure does not end the others). A mentioned member goes to the front of the queue
 * and takes the floor next, with the whole transcript; the members still waiting keep their place
 * behind it. Whoever spoke last is never next: nobody answers twice in a row.
 */
export function planNext(input: {
  readonly roster: readonly AgentInfo[];
  readonly speakerId: string;
  readonly reply: string | null;
  readonly state: ChainState;
}): NextTurns {
  const { roster, speakerId, reply, state } = input;
  const known = new Set(roster.map((info) => info.id));
  let queue = state.pending.filter((id) => known.has(id));
  let depth = state.depth;
  if (state.replies >= MAX_REPLIES_PER_MESSAGE) return { queue: [], depth, stop: 'reply_cap' };
  if (state.turns >= MAX_TURNS_PER_MESSAGE) return { queue: [], depth, stop: 'turn_cap' };

  if (reply !== null && depth < MAX_MENTION_DEPTH) {
    const handed = parseMentions(reply, roster, { exclude: speakerId }).slice(
      0,
      MAX_MENTIONS_PER_REPLY,
    );
    if (handed.length > 0) {
      depth += 1;
      queue = [...handed, ...queue.filter((id) => !handed.includes(id))];
    }
  }
  while (queue.length > 0 && queue[0] === state.lastSpeakerId) queue = queue.slice(1);
  return { queue, depth, stop: null };
}

/** A chain answers the person's LATEST message; a newer one makes it skip its remaining turns. */
export function isSuperseded(
  chainTriggerId: string,
  latestPersonMessageId: string | null,
): boolean {
  return latestPersonMessageId !== chainTriggerId;
}

/** Whether a room has stored as many replies as its window allows. */
export function roomRateExceeded(repliesInWindow: number): boolean {
  return repliesInWindow >= ROOM_REPLIES_PER_WINDOW;
}

// ── Declining ──

/** Whether a whole reply is the decline sentinel (`[pass]`, any case, optional full stop). */
export function isPass(text: string): boolean {
  return /^\[\s*pass\s*\]\.?$/i.test(text.trim());
}

/**
 * Holds back the start of a member's reply while it could still turn out to be the decline
 * sentinel, so `[pass]` is never shown. Anything else is released at once, in order.
 */
export function createPassGate(release: (text: string) => void): {
  push(text: string): void;
  /** Ends the reply: releases what was held unless it was the sentinel. Returns whether it was. */
  finish(): boolean;
} {
  let held = '';
  let open = false;
  const couldBeSentinel = (text: string) => {
    const compact = text.replace(/\s+/g, '').toLowerCase();
    return compact === '' || PASS_SENTINEL.startsWith(compact) || /^\[pass\]\.?$/.test(compact);
  };
  return {
    push(text) {
      if (open) return release(text);
      held += text;
      if (!couldBeSentinel(held)) {
        open = true;
        release(held);
        held = '';
      }
    },
    finish() {
      if (open) return false;
      if (isPass(held)) return true;
      if (held !== '') release(held);
      held = '';
      open = true;
      return false;
    },
  };
}

// ── Prompt ──

/** What a member is told about the room it speaks in, followed by the conversation so far. */
export function roomPrompt(input: {
  readonly self: AgentInfo;
  readonly roster: readonly AgentInfo[];
  readonly personText: string;
  /** Replies stored since the person's message, oldest first. */
  readonly since: readonly { readonly name: string; readonly content: string }[];
  /** The member that handed the floor to this one, or `null` for the person's own question. */
  readonly handedBy: string | null;
  /** The space this room belongs to (ADR 0028), if any: its name and the brief its members share. */
  readonly space?: { readonly name: string; readonly instructions: string } | null;
}): string {
  const others = input.roster
    .filter((info) => info.id !== input.self.id)
    .map((info) => `${info.name} (@${info.handle})`)
    .join(', ');
  const said =
    input.since.length === 0
      ? ''
      : `\n\nWhat the others have said since:\n\n${input.since
          .map((reply) => `${reply.name}: ${reply.content}`)
          .join('\n\n')}`;
  const turn =
    input.handedBy === null
      ? 'The person is asking you.'
      : `${input.handedBy} addressed you in the chat. If you have nothing of your own to add, answer with exactly ${PASS_SENTINEL} and nothing else: it will not be shown.`;
  const space = input.space
    ? `You are working in the space "${input.space.name}", together with ${others}.${
        input.space.instructions === ''
          ? ''
          : ` What this space is for, in the person's words:\n\n${input.space.instructions}\n\n`
      }Work as one team toward it. `
    : '';
  return [
    input.personText,
    '---',
    `${space}This is a group chat: the person and these agents are in it with you, ${others}. In this chat you go by ${input.self.name}. Anyone may talk to anyone: write @name or @handle to hand the floor to another agent, and the person sees everything. Speak in your own voice, as in a chat: short, add only what is yours to add, and do not repeat or summarize what others said. Do not write other agents' lines. ${turn}${said}`,
  ].join('\n\n');
}
