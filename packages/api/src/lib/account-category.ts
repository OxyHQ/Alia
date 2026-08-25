import { SELECTABLE_ACCOUNT_CATEGORY_IDS, type AccountCategoryId } from '@oxyhq/contracts';

/**
 * What an agent's bot ACCOUNT is about, in Oxy's own taxonomy.
 *
 * In `lib/` rather than `domain/`, and the gate in
 * `db/__tests__/schemaModelIndependence.test.ts` is why: a domain module is a
 * LEAF that imports nothing, which is right for Alia's own frozen vocabularies
 * (`agent-color.ts`, `capability-grants.ts`) and wrong for this — it is a thin
 * reading of somebody else's contract, and its whole point is not restating
 * what `@oxyhq/contracts` already says.
 *
 * One definition for both doors an agent can be born through — `POST
 * /agents/generate` behind the create screen, and the chat tool that makes one
 * mid-conversation. Two copies of this rule would be two chances for an agent
 * to arrive with a category through one door and without through the other,
 * which is the kind of divergence that later reads as a data bug.
 *
 * A different question from Alia's own `agents.category`, which is free text
 * feeding the catalogue's search. Neither can stand in for the other and they
 * are allowed to disagree — `routes/agents/generate.ts` says why, at the place
 * that answers both.
 */

/** The offered ids, as the list a model is shown. */
export const accountCategoryChoices = SELECTABLE_ACCOUNT_CATEGORY_IDS
  .map((id) => `"${id}"`)
  .join(', ');

/**
 * Whether a value IS one of the offered categories.
 *
 * Membership, and it has to be spelled out. `isSelectableAccountCategoryId`
 * from the contract answers a narrower question than its name suggests — "is
 * this id still offered", i.e. `!RETIRED.includes(id)` — and `RETIRED` is empty
 * today, so it answers TRUE for `undefined`, for `42`, for
 * `community_management`, for everything. Validating with it alone forwards
 * whatever a model invented straight to Oxy.
 *
 * `SELECTABLE_…` rather than the full set: that one still carries WITHDRAWN ids
 * so an account already holding one keeps it, and offering one of those to a
 * brand-new account would propose something the server refuses.
 */
export function isOfferedAccountCategory(value: unknown): value is AccountCategoryId {
  return typeof value === 'string'
    && (SELECTABLE_ACCOUNT_CATEGORY_IDS as readonly string[]).includes(value);
}
