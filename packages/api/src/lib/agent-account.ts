/**
 * An agent's Oxy `bot` account — verifying it, and deciding who may act as it.
 *
 * An agent has no identity of its own any more. It IS a `bot` account in the
 * Oxy account graph (`agents.oxy_account_id`), so the question "may this caller
 * edit this agent?" is not a question about an Alia row at all: it is
 * `account:act_as` over that account, and Oxy is the only thing that can answer
 * it.
 *
 * ## `author_oxy_user_id` is NOT the gate, and this module is why
 *
 * Every mutating agent route used to compare `agent.author === req.user.id`,
 * expressed as a predicate in the WHERE clause so a caller could not forget it.
 * That predicate answered a question Alia no longer owns: an owner may grant a
 * colleague `account:act_as` on the bot without handing over the row, and a
 * membership may be revoked while the column still names whoever created it.
 * The column survives as a listing index — "my agents" in one scan — and
 * `db/schema/agents.ts` says so where it is declared.
 *
 * The safety the WHERE clause provided is preserved by shape rather than by
 * SQL: {@link loadAgentForActor} is the only way a route obtains a mutable
 * agent, and it cannot return one without having asked Oxy first. A route that
 * fetched by id and compared afterwards is the failure this replaces, so no
 * route calls `findAgentById` on a write path.
 *
 * ## One call answers all three questions
 *
 * `GET /accounts/:id` returns the account (with its `kind`) AND
 * `callerMembership`, which is the server's OWN resolution of what this caller
 * holds — direct or inherited through the tree. So existence, kind and
 * `account:act_as` cost one round trip, not three, and the act-as verdict is
 * read through `canSwitchIntoAccount` from `@oxyhq/core` rather than by testing
 * for the permission string here. That predicate is the same one
 * `POST /accounts/:id/switch` enforces; a second copy of the rule in Alia would
 * be a place for it to go stale.
 *
 * `kind === 'bot'` is checked SEPARATELY and is not implied by the act-as
 * verdict: `organization` and `project` are act-as eligible too, and
 * `canSwitchIntoAccount` passes any account whose `relationship` is `self` —
 * the caller's own personal account — whatever its kind.
 *
 * ## A MUTATION never reads a cached verdict
 *
 * The cache below is for READ paths only, and every write passes
 * `cache: false`. Five minutes of a revoked membership still being effective is
 * a real window in which somebody writes to an account that is no longer
 * theirs — and `~/Oxy/AGENTS.md` says consistency-critical reads go
 * uncached for exactly this reason. The cost of the split is negligible in the
 * direction it is paid: writes are few and never in a loop, while the reads
 * that keep the cache are the ones that arrive in pages.
 *
 * The precedent this was first modelled on, the SDK's `verifyServiceActingAs`,
 * is an ATTRIBUTION lookup rather than a write gate. Same shape, different
 * blast radius.
 *
 * ## The client is per request, deliberately
 *
 * `middleware/auth.ts`'s module-level `oxyClient` carries no tokens and must
 * never be given any: it is shared across concurrent requests, so
 * `setTokens` on it leaks one caller's session into another's, which
 * `lib/oxy-user-hydration.ts` spells out at the one place that reads it. A
 * verdict is scoped to the caller, so it needs the caller's bearer, so it needs
 * its own client. One is built per cache MISS, not per request.
 */

import { OxyServices, canSwitchIntoAccount, type AccountNode } from '@oxyhq/core';
import type { AccountCategoryId } from '@oxyhq/contracts';
import type { Executor } from '../db/index.js';
import { findAgentById, type AgentRecord } from '../db/agents/agentRepository.js';
import {
  attachAgentIdentity,
  findAgentByOxyHandle,
  type HydratedAgent,
} from './agent-identity.js';
import { log } from './logger.js';

/** Why a caller may not act as an account. Maps 1:1 onto an HTTP status. */
export type AgentAccountRefusal =
  /** No such account, or the caller cannot see it. Deliberately indistinguishable. */
  | 'account_not_found'
  /** The account exists but is not a `bot`. */
  | 'not_a_bot_account'
  /** The account exists and is a bot, but this caller holds no `account:act_as`. */
  | 'not_permitted'
  /** Oxy could not be asked. NOT a denial — see {@link verifyAgentAccount}. */
  | 'identity_unavailable';

/**
 * A discriminated union, so `refusal` is only reachable on the branch that has
 * one. An optional field beside a boolean lets a caller read a refusal off a
 * grant, and the compiler would not mind.
 */
export type AgentAccountVerdict =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly refusal: AgentAccountRefusal };

const PERMITTED: AgentAccountVerdict = { permitted: true };

/**
 * How long a verdict may be reused.
 *
 * The same 5 minutes / 60 seconds the SDK's `verifyServiceActingAs` uses, and
 * for the same trade: a GRANT is stable (the normal case is somebody acting as
 * the bot account they themselves created, which does not change), while a
 * REFUSAL is usually transient — the account was created a moment ago, or the
 * membership is being added right now — so it is re-asked a minute later rather
 * than five.
 *
 * The cost is stated plainly: a REVOKED membership stays effective for up to
 * five minutes. Accepted, because the alternative is an Oxy round trip on every
 * read of every agent, and because nothing here is a security boundary Oxy is
 * not also enforcing on its own surfaces.
 */
const POSITIVE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 60_000;

interface CacheEntry {
  readonly verdict: AgentAccountVerdict;
  /**
   * Whether the caller holds ANY standing in the account — owner, or an active
   * membership of any role. A weaker fact than the verdict beside it and cached
   * from the SAME `getAccount`, because the two questions have one answer at
   * Oxy and asking twice would double the round trips on the read path.
   */
  readonly standing: boolean;
  readonly expiresAt: number;
}

/**
 * Keyed by the CALLER as well as the account. A verdict is about a pair, and a
 * cache keyed on the account alone would hand one caller's grant to another.
 */
const verdicts = new Map<string, CacheEntry>();

function cacheKey(oxyUserId: string, oxyAccountId: string): string {
  return `${oxyUserId}:${oxyAccountId}`;
}

/** Exported for tests, which must not inherit a verdict from a sibling case. */
export function clearAgentAccountVerdicts(): void {
  verdicts.clear();
}

/**
 * Store a verdict for the READ paths.
 *
 * A mutation writes here even though it never reads here, and that is the right
 * way round: the entry it leaves is fresh by construction, so a subsequent read
 * is served a verdict newer than one it would have cached itself. What a
 * mutation must never do is TRUST an entry, which is what `cache: false`
 * governs.
 */
function remember(key: string, verdict: AgentAccountVerdict, standing: boolean): AgentAccountVerdict {
  const ttl = verdict.permitted ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
  verdicts.set(key, { verdict, standing, expiresAt: Date.now() + ttl });
  return verdict;
}

/**
 * Does the caller hold any standing in this account at all?
 *
 * A weaker question than `account:act_as`, and it has to be: sharing an agent
 * IS adding somebody to its bot account, and a role that can use an agent is
 * not necessarily one that can BECOME it. Reading `act_as` as "was shared with
 * me" would make sharing work only for the roles that can also edit.
 *
 * Owner is included without a membership row, because ownership is implicit
 * there — `callerMembership` is `null` on an account you own.
 */
function hasStanding(node: AccountNode): boolean {
  if (node.relationship === 'self' || node.relationship === 'owner') return true;
  /**
   * A SUPERSET of the act-as verdict, never a rival test. Whoever may become
   * the account plainly has standing in it, and deciding this on the membership
   * row alone would refuse somebody the other question just admitted — an
   * inconsistency with no way to reach it from the outside and no way to
   * explain it from the inside.
   */
  if (canSwitchIntoAccount(node)) return true;
  return node.callerMembership?.status === 'active';
}

/**
 * May this caller act as this Oxy `bot` account?
 *
 * `identity_unavailable` is a REFUSAL and is never cached as a grant: an Oxy
 * outage must not become a window in which anybody may edit anybody's agent.
 * It is distinct from `not_permitted` so the route can answer 502 rather than
 * 403 — telling an owner their own agent is not theirs is a worse lie than
 * telling them the identity service is down.
 */
export async function verifyAgentAccount(params: {
  oxyUserId: string;
  accessToken: string;
  oxyAccountId: string;
  /**
   * Whether a cached verdict may answer this call. NO DEFAULT, on purpose: a
   * caller has to state which kind of path it is, and the compiler asks. A
   * default of `true` would make every new write path cached by omission,
   * which is the failure this parameter exists to prevent.
   */
  cache: boolean;
}): Promise<AgentAccountVerdict> {
  const key = cacheKey(params.oxyUserId, params.oxyAccountId);
  if (params.cache) {
    const cached = verdicts.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.verdict;
  }

  const oxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
  oxy.setTokens(params.accessToken);

  let node: Awaited<ReturnType<typeof oxy.getAccount>>;
  try {
    node = await oxy.getAccount(params.oxyAccountId);
  } catch (error: unknown) {
    // Oxy answers 404 for an account the caller cannot see, which is the same
    // response as one that does not exist — and both are cacheable refusals.
    // Anything else is Alia failing to ASK, which is not a verdict at all.
    if (isNotFound(error)) {
      return remember(key, { permitted: false, refusal: 'account_not_found' }, false);
    }
    log.general.warn(
      { err: error, oxyAccountId: params.oxyAccountId },
      'Oxy could not resolve an agent account; refusing without caching',
    );
    return { permitted: false, refusal: 'identity_unavailable' };
  }

  const standing = hasStanding(node);
  if (node.account?.kind !== 'bot') {
    return remember(key, { permitted: false, refusal: 'not_a_bot_account' }, standing);
  }
  if (!canSwitchIntoAccount(node)) {
    return remember(key, { permitted: false, refusal: 'not_permitted' }, standing);
  }
  return remember(key, PERMITTED, standing);
}

/**
 * A 404 from Oxy, told apart from every other transport failure.
 *
 * The SDK rejects with an error carrying `status`; a network failure carries
 * none. Reading `status` off an `unknown` without asserting anything about the
 * error's type is the point — a thrown string must not read as a 404.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 404;
}

/** The HTTP status a refusal answers with. */
export function refusalStatus(refusal: AgentAccountRefusal): 400 | 403 | 404 | 502 {
  switch (refusal) {
    case 'account_not_found':
      return 404;
    case 'not_a_bot_account':
      return 400;
    case 'not_permitted':
      return 403;
    case 'identity_unavailable':
      return 502;
  }
}

/** The message a refusal answers with. Says what is wrong, names no internals. */
export function refusalMessage(refusal: AgentAccountRefusal): string {
  switch (refusal) {
    case 'account_not_found':
      return 'Account not found';
    case 'not_a_bot_account':
      return 'The account is not a bot account';
    case 'not_permitted':
      return 'You do not have permission to act as this account';
    case 'identity_unavailable':
      return 'The identity service is unavailable';
  }
}

export type AgentForActor =
  | { readonly ok: true; readonly agent: AgentRecord }
  | { readonly ok: false; readonly refusal: AgentAccountRefusal | 'agent_not_found' };

/**
 * The agent a caller may write to, or the reason they may not.
 *
 * THE ONLY WAY a write path obtains an agent. It loads the row, then asks Oxy
 * whether this caller may act as the account that row names — in that order,
 * because the account id lives on the row. A route that called
 * `findAgentById` itself and authorised afterwards would be the leak the old
 * `{_id, author}` predicate existed to prevent; there is one such sequence in
 * the service and it is here.
 */
export async function loadAgentForActor(
  db: Executor,
  params: {
    agentId: string;
    oxyUserId: string;
    accessToken: string;
    /** `false` on every write path. See the file comment. */
    cache: boolean;
  },
): Promise<AgentForActor> {
  const agent = await findAgentById(db, params.agentId);
  if (agent === null) return { ok: false, refusal: 'agent_not_found' };

  const verdict = await verifyAgentAccount({
    oxyUserId: params.oxyUserId,
    accessToken: params.accessToken,
    oxyAccountId: agent.oxyAccountId,
    cache: params.cache,
  });
  if (!verdict.permitted) {
    // `not_permitted` becomes `agent_not_found` deliberately, and it is what the
    // owner predicate in the old WHERE clause already did: an agent nobody has
    // told this caller about is not confirmed to exist by a 403. Every other
    // refusal names a real, actionable condition and survives as itself.
    if (verdict.refusal === 'not_permitted') return { ok: false, refusal: 'agent_not_found' };
    return { ok: false, refusal: verdict.refusal };
  }
  return { ok: true, agent };
}

/**
 * Mint the Oxy `bot` account a new agent will BE.
 *
 * Server-side counterpart of what the app does with `useOxy().createAccount`:
 * the chat tool that creates agents mid-conversation has no screen to put a
 * username picker on, so it proposes one and this resolves the collision.
 *
 * ## Uniqueness is Oxy's, and so is the collision
 *
 * `username` shares `User.username`'s unique index across the WHOLE account
 * graph — every person, organization, project, bot and channel in Oxy — so no
 * query Alia can run answers "is this free", and the three copies of
 * slugify-then-check-`agents`-then-suffix that used to try are gone. The
 * authority is the response to `POST /accounts`, and a 409 is not a failure
 * here: it is the answer, and the reply is a fresh suggestion.
 *
 * Bounded at {@link USERNAME_ATTEMPTS} tries. An unbounded loop against a
 * remote service is a way to turn a persistent 409 — a validation rule this
 * code does not know about, say — into a hot loop against Oxy.
 *
 * A conflict is recognised by STATUS, not by message text: a 409 is the
 * contract, and matching prose would break the moment Oxy rephrased it. Any
 * other failure is rethrown, because a caller silently retrying an
 * authorization error with a different username would hide it.
 */
const USERNAME_ATTEMPTS = 5;

export async function createAgentBotAccount(params: {
  accessToken: string;
  username: string;
  displayName: string;
  bio?: string;
  parentAccountId?: string;
  /**
   * A named preset KEY — `'blue'`, `'mint'`, … — never a hex value, and set at
   * CREATION rather than after it: for a managed account the colour is a visual
   * identity, and an account that exists without one and acquires it on a
   * second request is a face that changes by itself.
   */
  color?: string;
  /**
   * What the account is about. ORDERED at Oxy, first element primary — an agent
   * is offered exactly one, so the head is trivially right.
   */
  accountCategories?: AccountCategoryId[];
}): Promise<{ oxyAccountId: string; username: string }> {
  const oxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
  oxy.setTokens(params.accessToken);

  let username = params.username;
  for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt++) {
    try {
      const node = await oxy.createAccount({
        kind: 'bot',
        username,
        name: { displayName: params.displayName },
        ...(params.bio !== undefined && { bio: params.bio }),
        ...(params.parentAccountId !== undefined && { parentAccountId: params.parentAccountId }),
        ...(params.color !== undefined && { color: params.color }),
        ...(params.accountCategories !== undefined && {
          accountCategories: params.accountCategories,
        }),
      });
      return { oxyAccountId: node.accountId, username };
    } catch (error: unknown) {
      if (!isConflict(error)) throw error;
      // A suffix rather than a counter: a counter races with every other client
      // proposing the same base, and would spend all five attempts walking the
      // same taken sequence.
      username = `${params.username}-${Math.random().toString(36).slice(2, 6)}`;
    }
  }
  throw new Error(`could not mint a bot account: ${USERNAME_ATTEMPTS} usernames were all taken`);
}

function isConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { status?: unknown }).status === 409;
}

/**
 * May this caller USE this agent — chat with it, open its thread, hire it?
 *
 * The one place the rule is written, because two copies of it would be two
 * chances to leave one of them at "published only" or at "owner only", and
 * neither mistake is visible from the call site.
 *
 * ## Being listed is not being usable, and it used to be
 *
 * This began `if (agent.isPublished && agent.status === 'active') return true`,
 * so `is_published` answered two questions at once: does it appear in the
 * catalogue, and may anyone run it. The combination people actually want —
 * listed, so it can be found, but mine to lend — could not be said. Now
 * `is_published` decides only the first and `access` decides this one:
 *
 *  - `public` and active — anyone, signed in or not. Same as the old published
 *    branch, and just as cheap.
 *  - `private` — its owner, and whoever holds a MEMBERSHIP on its bot account.
 *    Sharing an agent is adding somebody to that account, which is what
 *    "hiring" became.
 *
 * Standing rather than `account:act_as`, and the difference is the whole point
 * of sharing: a role that may use an agent is not necessarily one that may
 * BECOME it. Reading act-as as "was shared with me" would make sharing work
 * only for the roles that can also edit — and editing is where the prompt is.
 * {@link verifyAgentAccount} answers both from one `getAccount`, so the weaker
 * question costs no extra round trip.
 *
 * A DRAFT — not published — reaches the same second branch: its owner may use
 * it, and nobody else may, exactly as before.
 *
 * A caller with no bearer cannot be asked about, so a private agent is
 * unreachable to them. That is the same answer as "no such agent", which is the
 * answer a route must give: see {@link loadThreadAgent}.
 */
export async function canReachAgent(
  agent: AgentRecord,
  caller: { oxyUserId: string; accessToken: string | undefined },
): Promise<boolean> {
  if (agent.access === 'public' && agent.status === 'active') return true;
  if (caller.accessToken === undefined) return false;
  return holdsAgentStanding({
    oxyUserId: caller.oxyUserId,
    accessToken: caller.accessToken,
    oxyAccountId: agent.oxyAccountId,
  });
}

/**
 * Whether the caller owns the agent's bot account or was added to it.
 *
 * Reads the verdict cache that {@link verifyAgentAccount} fills, so the answer
 * costs one Oxy round trip per caller per agent per five minutes rather than
 * one per turn. It asks the act-as question on a miss, but returns the WEAKER
 * fact recorded beside it — a member who cannot act as the account still has
 * standing in it.
 */
export async function holdsAgentStanding(params: {
  oxyUserId: string;
  accessToken: string;
  oxyAccountId: string;
}): Promise<boolean> {
  const key = cacheKey(params.oxyUserId, params.oxyAccountId);
  const cached = verdicts.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.standing;
  await verifyAgentAccount({ ...params, cache: false });
  return verdicts.get(key)?.standing ?? false;
}

/**
 * The agent behind an @handle that this caller may reach, or null.
 *
 * What `GET /agents/thread/:username` resolves `/a/pepe` through. Two hops,
 * because a handle is Oxy's: the username resolves to an ACCOUNT and the
 * account to an agent, which is why `agents.oxy_account_id` is unique.
 *
 * **Every refusal is the same `null`, and that is the point.** No such
 * username, a username that is a person rather than an agent, an unpublished
 * agent belonging to somebody else, and Oxy being unreachable all mean "you
 * cannot open this thread". A route that distinguished them would answer 403
 * for the third — and a 403 confirms the agent EXISTS, which is precisely what
 * an unpublished draft must not leak to a stranger who guessed a handle.
 */
export async function loadThreadAgent(
  db: Executor,
  params: { username: string; oxyUserId: string; accessToken: string | undefined },
): Promise<HydratedAgent | null> {
  const agent = await findAgentByOxyHandle(db, params.username, { hireableOnly: false });
  if (agent === null) return null;
  if (!(await canReachAgent(agent, params))) return null;
  return attachAgentIdentity(agent);
}

/**
 * The agent a TURN is for, named explicitly by the request.
 *
 * ## Explicit, because the inference was broken for its whole life
 *
 * This replaces `findConversationAgentById(conversationId)`, which addressed the
 * conversations table's PRIMARY KEY while `conversationId` is the client's
 * BUSINESS key (a `randomUUID()` minted by `POST /conversations/new`). It could
 * not match, so the escalation branch behind it never ran once — and the
 * Mongoose original threw a CastError that both call sites caught and turned
 * into `null`, which is why nothing ever looked wrong.
 *
 * The client has been sending `agentId` on the request body all along
 * (`use-streaming-chat.ts`) and nothing read it. So the turn reads it, and
 * derives nothing: an agent is a parameter, not a thing to work out from a
 * thread id.
 *
 * ## `agentId` is CLIENT INPUT, so it is authorised
 *
 * By {@link canReachAgent}, which is the same rule `GET /agents/thread/:username`
 * applies — published-and-active, or `account:act_as` on the bot account.
 *
 * A refusal is `null` rather than an error. A turn naming an agent the caller
 * may not use is still a valid chat turn; it simply runs as ordinary Alia,
 * which is exactly what happened for every turn before this worked.
 */
export async function loadTurnAgent(
  db: Executor,
  params: { agentId: string; oxyUserId: string; accessToken: string | undefined },
): Promise<HydratedAgent | null> {
  const agent = await findAgentById(db, params.agentId);
  if (agent === null) return null;
  if (!(await canReachAgent(agent, params))) return null;
  return attachAgentIdentity(agent);
}
