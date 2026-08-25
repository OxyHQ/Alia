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
 */

import type { AccountNode, CreateAccountInput } from '@oxyhq/core';

const USERNAME_ATTEMPTS = 5;

export interface CreateBotAccountInput {
  /** `useOxy().createAccount`, passed in so this stays a plain function. */
  createAccount: (data: CreateAccountInput) => Promise<AccountNode>;
  /** The suggestion from `POST /agents/generate`. Never reserved. */
  username: string;
  /** The agent's name, as a person reads it. */
  displayName: string;
  bio?: string;
  /** An Oxy asset id, from `POST /agents/avatar/generate`. Never a URL. */
  avatar?: string;
}

/** A conflict, told apart by STATUS — matching prose breaks when Oxy rephrases it. */
function isConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { status?: unknown }).status === 409;
}

export async function createBotAccount(input: CreateBotAccountInput): Promise<AccountNode> {
  let username = input.username;

  for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt++) {
    try {
      return await input.createAccount({
        kind: 'bot',
        username,
        name: { displayName: input.displayName },
        ...(input.bio !== undefined && { bio: input.bio }),
        ...(input.avatar !== undefined && { avatar: input.avatar }),
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
