/**
 * An agent's name, handle and colour — read from Oxy, never from Alia.
 *
 * `agents` stores an `oxy_account_id` and nothing else about who the agent is.
 * Every response that renders an agent therefore has to resolve that account,
 * and this is the one place that does it: ONE batch call for a whole page
 * through {@link hydrateOxyUsers}, which wraps `POST /users/by-ids` (cap 100,
 * deduplicated and chunked by the SDK). A per-agent `getUserById` in a loop is
 * the shape this exists to prevent — a catalogue page of fifty agents would be
 * fifty round trips.
 *
 * ## An unresolvable account renders as nulls, and that is deliberate
 *
 * `hydrateOxyUsers` FAILS OPEN: an id Oxy cannot resolve — deleted, federated,
 * or simply unreachable because Oxy is having a bad afternoon — is absent from
 * the map. So `name`, `handle` and `avatar` are nullable ON THE WIRE, and a
 * client renders its own fallback. The alternative is letting an identity
 * lookup decide whether a marketplace listing can be displayed at all, when the
 * listing itself — the tagline, the rating, the price — is stored right here.
 *
 * ## An agent has no avatar, and the colour is what replaced it
 *
 * Agent avatars were generated images stored as Oxy assets and resolved to a
 * URL here. They are gone: an agent is drawn as a glyph tinted with its own
 * colour, so what a client needs is `User.color` — a Bloom preset key Oxy
 * already stores for every account — and not an address. The consequence is
 * accepted and stated once: an agent renders with Oxy's placeholder anywhere
 * Alia's own client does not reach, Mention included, and the colour is what
 * lets those surfaces tint a placeholder without an image existing.
 */

import { randomUUID } from 'crypto';
import {
  USERNAME_MAX_LENGTH,
  isValidUsername,
  stripDisallowedUsernameCharacters,
} from '@oxyhq/contracts';
import type { Executor } from '../db/index.js';
import {
  findAgentByOxyAccountId,
  findHireableAgentByOxyAccountId,
  type AgentRecord,
} from '../db/agents/agentRepository.js';
import { oxyClient } from '../middleware/auth.js';
import { log } from './logger.js';
import { hydrateOxyUsers } from './oxy-user-hydration.js';

/** What a client renders for an agent. Every field nullable — see the file comment. */
export interface AgentIdentity {
  /** `name.displayName` when Oxy resolved one, else the normalized handle. */
  name: string | null;
  /** The Oxy username. Globally unique across the whole account graph. */
  handle: string | null;
  /**
   * A Bloom colour preset key — `"blue"`, `"lagoon"` — never a hex.
   *
   * Null far more often than the other two: an owner who never picked one, an
   * Oxy that does not serve the field, and an account that failed to resolve
   * all arrive here the same way, so a client's fallback is the NORMAL path
   * rather than an edge case. `domain/agent-color.ts` says why this service
   * proposes colours and validates none.
   */
  color: string | null;
  /**
   * The AUTHOR's display name — the person who created the agent, which is a
   * different account from the agent's own and a separate claim on the listing.
   *
   * Resolved in the SAME batch as the bot account, because both are Oxy account
   * ids and `POST /users/by-ids` does not care which is which. Two calls would
   * be two round trips for one card.
   *
   * There is no `authorVerified` beside it. That was an Alia column asserting
   * something about somebody else's account, written by exactly one code path
   * and true of zero rows; a verification claim belongs to the service that
   * owns the identity.
   */
  authorName: string | null;
}

/**
 * The identity of an account Oxy did not resolve: every field null.
 *
 * Exported because failing open is a CONTRACT, not an implementation detail —
 * a caller resolving identities in a batch has to render the rows Oxy could not
 * answer for, and inventing a second empty identity beside this one is how two
 * surfaces start disagreeing about what an unresolved agent looks like.
 */
export const UNRESOLVED_IDENTITY: AgentIdentity = {
  name: null,
  handle: null,
  color: null,
  authorName: null,
};

/**
 * Resolve many bot accounts in ONE round trip.
 *
 * Returns a map rather than an array so a caller can attach identities to rows
 * in whatever order it already holds them, and so an unresolved id is a MISSING
 * KEY rather than a hole at an index that has to be lined up by position.
 */
export async function resolveAgentIdentities(
  oxyAccountIds: readonly string[],
): Promise<Map<string, AgentIdentity>> {
  const users = await hydrateOxyUsers(oxyAccountIds);
  const identities = new Map<string, AgentIdentity>();
  for (const [id, user] of users) {
    identities.set(id, {
      name: user.displayName,
      handle: user.username,
      color: user.color ?? null,
      // Filled in by `attachAgentIdentities`, which is the only caller that
      // knows which author goes with which agent. A bare account id has no
      // author of its own.
      authorName: null,
    });
  }
  return identities;
}

/**
 * Attach an identity to every row that names a bot account.
 *
 * Generic over the row so it serves an `AgentRecord`, a team's projected agent
 * and a session's embedded one without three copies. The identity fields are
 * spread LAST, so a row that somehow carried a stale `name` of its own cannot
 * win over Oxy's.
 */
export async function attachAgentIdentities<T extends { oxyAccountId: string; author?: string }>(
  rows: readonly T[],
): Promise<(T & AgentIdentity)[]> {
  if (rows.length === 0) return [];
  // ONE batch for both kinds of account. `hydrateOxyUsers` deduplicates, so an
  // agent whose author is also its own bot account costs one entry, not two.
  const identities = await resolveAgentIdentities([
    ...rows.map((row) => row.oxyAccountId),
    ...rows.flatMap((row) => (typeof row.author === 'string' ? [row.author] : [])),
  ]);
  return rows.map((row) => {
    const own = identities.get(row.oxyAccountId) ?? UNRESOLVED_IDENTITY;
    const author = typeof row.author === 'string' ? identities.get(row.author) : undefined;
    return { ...row, ...own, authorName: author?.name ?? null };
  });
}

/** One row. Still one round trip, and the same failure-open contract. */
export async function attachAgentIdentity<T extends { oxyAccountId: string }>(
  row: T,
): Promise<T & AgentIdentity> {
  const [hydrated] = await attachAgentIdentities([row]);
  return hydrated;
}

/** An agent record with its Oxy identity already attached. */
export type HydratedAgent = AgentRecord & AgentIdentity;

/**
 * The name a PROMPT gives the model. NEVER null.
 *
 * `AgentIdentity.name` is nullable because a client can render a fallback and
 * an unresolvable account must not blank a whole listing. A system prompt has
 * no such luxury: `You are ${null}.` is a sentence the model will believe, and
 * it is the one string in this file that must always be a name. The handle is
 * tried first because it is still the agent's own identity; only when Oxy
 * resolved nothing at all does the generic word stand in.
 */
export function agentPromptName(agent: AgentIdentity): string {
  return agent.name ?? agent.handle ?? 'Agent';
}

/**
 * The agent behind an @handle — two hops, because a handle is Oxy's.
 *
 * A delegation says `@researcher`, and Alia has no column to match that against
 * any more. So the handle is resolved to an ACCOUNT at Oxy and the account to an
 * agent here, which is why `agents.oxy_account_id` is UNIQUE.
 *
 * `hireableOnly` is a parameter rather than two functions because the two
 * callers differ in exactly that predicate and nothing else — and because a
 * caller choosing between two near-identical function names is how the
 * published/active check goes missing.
 *
 * Returns null for every failure, and they are genuinely the same answer to the
 * caller: no such handle, a handle that is a person rather than an agent, an
 * agent that is unpublished, and Oxy being unreachable all mean "you cannot
 * delegate to this right now". The Oxy failure is logged so a spike is visible
 * as something other than users mistyping handles.
 */
export async function findAgentByOxyHandle(
  db: Executor,
  handle: string,
  options: { hireableOnly: boolean },
): Promise<AgentRecord | null> {
  // A leading `@` is how a person writes a handle and is not part of it.
  const username = handle.replace(/^@/, '').trim();
  if (username === '') return null;

  let accountId: string;
  try {
    const profile = await oxyClient.getProfileByUsername(username);
    if (typeof profile.id !== 'string' || profile.id === '') return null;
    accountId = profile.id;
  } catch (error: unknown) {
    log.general.warn({ err: error, username }, 'Oxy could not resolve an agent handle');
    return null;
  }

  return options.hireableOnly
    ? findHireableAgentByOxyAccountId(db, accountId)
    : findAgentByOxyAccountId(db, accountId);
}

/** The label a bot's handle ends in. Lower-case: the comparison folds case. */
const BOT_USERNAME_SUFFIX = 'bot';

/**
 * Label a proposed handle, so what Alia sends is what Oxy will take.
 *
 * Every account Alia mints is `kind: 'bot'`, and Oxy holds that one kind to a
 * tighter username rule than the other four: everything {@link isValidUsername}
 * already demanded, plus a handle that ENDS in `bot`. So `garden-helper` is
 * refused where `garden-helperbot`, `garden-bot` and `GardenBOT` are not — the
 * label says what the account is at the point where the handle is read, which
 * is the only part of an account that travels into a URL or a mention.
 *
 * ## Applied at the EDGE, after the collision suffix, never before it
 *
 * {@link suggestAgentUsername} proposes a base and `createAgentBotAccount`
 * labels it on the way out, so a retry rewrites the base and the label goes
 * back on top of the rewrite: `nadia` → taken → `nadia-i` → `nadia-ibot`.
 * Labelling first would produce `nadiabot-i`, refused for exactly the reason
 * the first attempt was, five times in a row — a loop that only terminates
 * because somebody bounded it.
 *
 * ## This lives here TEMPORARILY
 *
 * `@oxyhq/contracts` owns the rule — `usernameSchema` and the length live
 * there — but it does NOT publish this function yet. Measured against the
 * registry: `0.34.0`, today's `latest`, exports `usernameSchema`,
 * `isValidUsername`, `stripDisallowedUsernameCharacters` and the three length
 * constants, and nothing named `applyBotUsernameSuffix`. So bumping the
 * dependency does not retire this; the helper has to be published upstream
 * first, and only then does this go and the import take its place — same name,
 * same behaviour, so no call site here moves. Nothing else in Alia may restate
 * the rule in the meantime.
 *
 * It APPENDS and never inserts, leaving the separator to whoever chose the
 * name, and it truncates to leave room rather than overflowing
 * {@link USERNAME_MAX_LENGTH}. The label is ASCII alphanumeric, so appending it
 * to a handle the schema accepts yields another one — it can introduce neither
 * a repeated separator nor an edge one.
 *
 * Case-insensitive and therefore idempotent, folded exactly as Oxy's own unique
 * index folds (`lower(btrim(username))`): `mybot` and `MYBOT` come back
 * untouched rather than becoming `mybotbot`.
 */
export function applyBotUsernameSuffix(candidate: string): string {
  const trimmed = candidate.trim();
  if (trimmed.toLowerCase().endsWith(BOT_USERNAME_SUFFIX)) return trimmed;
  return trimmed.slice(0, USERNAME_MAX_LENGTH - BOT_USERNAME_SUFFIX.length) + BOT_USERNAME_SUFFIX;
}

/**
 * A username to OFFER Oxy for a new agent's bot account.
 *
 * The three copies of this slugify-then-suffix block — the generate route, the
 * chat tool, and `POST /agents` — are one function now, and it lost the half
 * that was wrong: each copy asked Alia's own `agents` table whether the handle
 * was free, then inserted, which is a check-then-insert race AND the wrong
 * question, since Oxy's `User.username` index spans the whole account graph.
 *
 * So this proposes and never decides. `POST /accounts` is the authority, its
 * duplicate answer is the only true one, and the CLIENT retries with a fresh
 * suggestion — it is the only layer with the person in front of it.
 *
 * ## It SHAPES a candidate and lets the schema judge it
 *
 * `@oxyhq/contracts` owns the username rules — one Zod schema, replacing the
 * seven copies that used to disagree. This was the eighth, and it re-encoded a
 * SUBSET, which is the worst of both: it knew about empty slugs and leading
 * digits, and it did not know about the minimum length, so "Al" proposed `al`
 * and collected a 400 from a server it had never asked.
 *
 * It also invented a rule. Leading digits are FINE — `isValidUsername('123')`
 * is true — so agents named "1984" were being handed a random fallback for a
 * name the server would have taken.
 *
 * What is left here is shaping, which is style rather than law: lowercase,
 * whitespace to a single hyphen, disallowed characters removed by the schema's
 * own `stripDisallowedUsernameCharacters`, and a cut at the schema's own
 * maximum. Truncating can land on a separator, and a trailing one is refused,
 * so it is trimmed — an improvement to the proposal, not a verdict on it.
 * `isValidUsername` gives the verdict, and it gives it last.
 *
 * ## It proposes a NAME, and the minter adds the label
 *
 * What comes back does not end in `bot` and is not meant to: this is the base a
 * bot handle is built from, and {@link applyBotUsernameSuffix} is applied by
 * whoever sends it to Oxy — `createAgentBotAccount` here, `createBotAccount` in
 * the app. The label has to go on LAST, after any collision suffix, or the
 * suffix lands outside it and the handle stops conforming: this is the layer
 * that makes `nadia2` possible, and the edge is what makes it `nadia2bot`.
 *
 * ## `null` means "I have nothing to offer"
 *
 * Better than proposing something the server will refuse. The caller supplies
 * {@link fallbackAgentUsername}, which is not this function's judgement to
 * make — a screen with somebody in front of it may want to ask instead.
 *
 * A COLLIDING username is nobody's business here: `POST /accounts` is the
 * authority on uniqueness, its answer is the only true one, and the client
 * retries.
 */
export function suggestAgentUsername(name: string): string | null {
  const shaped = stripDisallowedUsernameCharacters(
    name.toLowerCase().normalize('NFKD').trim().replace(/\s+/g, '-'),
  )
    .slice(0, USERNAME_MAX_LENGTH)
    .replace(/[-_]+$/, '');

  return isValidUsername(shaped) ? shaped : null;
}

/**
 * A username for an agent whose name proposes none.
 *
 * Built from a UUID rather than `Math.random().toString(36)`, whose suffix can
 * come back SHORT — `(0).toString(36).slice(2, 8)` is the empty string, which
 * makes `agent-`, which ends in a separator and is refused. Rare enough never
 * to be seen and certain enough to be avoided.
 *
 * Asserted valid by the suite rather than by reading: a fallback that the
 * schema refuses would turn "no name to propose" into "cannot create an agent".
 *
 * A base like the one above, and unlabelled for the same reason: the minter
 * appends `bot` after resolving any collision, so this one becomes
 * `agent-3f2a91bcbot` on the way out.
 */
export function fallbackAgentUsername(): string {
  return `agent-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
