/**
 * Minting the Oxy `bot` account an agent IS.
 *
 * An agent has no identity in Alia. It is a `bot` account in the Oxy account
 * graph — a child of the signed-in person's own account, which is what makes
 * them its owner — and `agents.oxy_account_id` is the only thing Alia stores
 * about who it is.
 *
 * ## The username collision is resolved HERE, and only here
 *
 * `username` shares `User.username`'s unique index across the WHOLE Oxy account
 * graph: every person, organization, project, bot and channel. No query Alia
 * can run answers "is this free", so `POST /agents/generate` returns a
 * SUGGESTION and the authority is Oxy's answer to `POST /accounts`.
 *
 * A 409 is therefore not a failure, it is the answer — and this is the layer
 * that has the person in front of it, so it retries rather than surfacing an
 * error nobody can act on. Creating an agent stays one screen and one tap,
 * which is the whole point of doing it here instead of in a picker.
 *
 * Bounded at {@link USERNAME_ATTEMPTS}: an unbounded retry against a remote
 * service turns a validation rule this code does not know about into a hot loop.
 *
 * ## The account is born UNDISCOVERABLE when the caller says so
 *
 * `isPrivateAccount` keeps the account out of Oxy's people search, the
 * follow-graph lists and the recommendation pools from the moment it exists.
 * It is stated at CREATION rather than repaired afterwards: turning it on later
 * is `PUT /users/:userId/privacy` with the ACCOUNT's own bearer, which leaves
 * the agent listed in the meantime — and an agent is listed under its owner's
 * name before its owner has published it.
 *
 * Omitting it is not the same as sending `false`: silence takes Oxy's default,
 * which is discoverable. So {@link CreateBotAccountInput.private} is forwarded
 * only when the caller stated it, and every attempt of the retry loop carries
 * what the first one did.
 */

import type { AccountCategoryId, AccountNode, CreateAccountInput } from '@oxyhq/core';

const USERNAME_ATTEMPTS = 5;

export interface CreateBotAccountInput {
  /** `useOxy().createAccount`, passed in so this stays a plain function. */
  createAccount: (data: CreateAccountInput) => Promise<AccountNode>;
  /** The suggestion from `POST /agents/generate`. Never reserved. */
  username: string;
  /**
   * `oxyServices.checkUsernameAvailability`, asked BEFORE minting so a taken
   * suggestion becomes a free one the person is told about, rather than a
   * silent rename they find later.
   *
   * Optional: without it this behaves exactly as it did, and the retry below is
   * the only defence. That matters right now, because the two are landing at
   * different times — Oxy still SUFFIXES on collision today, so this is the
   * only thing standing between a person and `community-maestro1` appearing
   * unannounced; when Oxy starts answering 409 the retry becomes live and the
   * two cover each other. Neither is written assuming the other.
   */
  checkAvailability?: (username: string) => Promise<boolean>;
  /** The agent's name, as a person reads it. */
  displayName: string;
  bio?: string;
  /**
   * What the account is ABOUT, as Oxy's own taxonomy names it — validated by
   * `POST /agents/generate` against `@oxyhq/contracts` before it ever gets
   * here, so this forwards and does not judge.
   *
   * ORDERED at Oxy, first element primary; an agent is offered exactly one.
   * Absent means "no categories", which is a valid state — an empty array
   * would mean "clear them", and those are not the same request.
   */
  accountCategories?: AccountCategoryId[];
  /**
   * Create the account already opted OUT of discovery, sent to Oxy as
   * `CreateAccountInput.isPrivateAccount`. The create screen sets it because it
   * builds a DRAFT agent: unpublished in Alia's catalogue, and unlisted in Oxy's
   * people search to match. Left unset, the account takes Oxy's default and is
   * discoverable — see the file comment.
   */
  private?: boolean;
}

/** A conflict, told apart by STATUS — matching prose breaks when Oxy rephrases it. */
function isConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { status?: unknown }).status === 409;
}

/**
 * The first free name at or after the suggestion: `pepe`, `pepe2`, `pepe3`.
 *
 * A COUNTER here, where the retry below uses a random suffix, and the
 * difference is not an oversight. The retry is reacting to a collision it has
 * already hit, so it needs to jump away from a sequence every other client is
 * walking at the same moment. This is choosing a name to SHOW somebody, and
 * `pepe2` is a name a person can read back, remember and type — `pepe-a7f3` is
 * not. It is also the shape Oxy's own suffixing produces, so a handle chosen
 * here looks like one chosen there.
 *
 * An unanswerable check ends the walk and returns the candidate it was holding:
 * the server is still the authority, and a search that cannot proceed must not
 * become a refusal to create.
 */
async function firstFreeUsername(
  suggestion: string,
  checkAvailability: (username: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? suggestion : `${suggestion}${String(attempt + 1)}`;
    try {
      if (await checkAvailability(candidate)) return candidate;
    } catch {
      return candidate;
    }
  }
  return suggestion;
}

export async function createBotAccount(input: CreateBotAccountInput): Promise<AccountNode> {
  let username = input.checkAvailability === undefined
    ? input.username
    : await firstFreeUsername(input.username, input.checkAvailability);

  for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt++) {
    try {
      return await input.createAccount({
        kind: 'bot',
        username,
        name: { displayName: input.displayName },
        ...(input.bio !== undefined && { bio: input.bio }),
        ...(input.accountCategories !== undefined && { accountCategories: input.accountCategories }),
        ...(input.private !== undefined && { isPrivateAccount: input.private }),
      });
    } catch (error: unknown) {
      if (!isConflict(error)) throw error;
      // A random suffix rather than a counter: a counter races with every other
      // client proposing the same base name, and would spend all five attempts
      // walking the same taken sequence.
      username = `${input.username}-${Math.random().toString(36).slice(2, 6)}`;
    }
  }

  throw new Error('That name is taken. Try describing your agent differently.');
}
