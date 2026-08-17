/**
 * The extension's build-time preferences.
 *
 * `PREFERRED_MODEL_ID` is the one identifier this package is allowed to name,
 * and it carries the same warning every other client's preference does: **it is
 * never trusted.** The catalogue carries no default of its own — it orders
 * entries by price and says explicitly that position is not a recommendation —
 * so a build-time value is the only mechanism for "what should this ask for
 * first", and `resolveSelection` in `./catalogue` then checks it against what
 * the server actually offers.
 *
 * It duplicates the `default` on the `codea.model` contribution in
 * `package.json`, which is the value VS Code hands back when a user has not set
 * one. The two are kept in step by `scripts/check-model-defaults.mjs`, which
 * permits this module exactly one identifier and forbids every other module in
 * the package from naming any: a second copy appearing in a provider is what
 * this whole workstream is removing.
 */

/** What a request asks for when the user has expressed no preference. */
export const PREFERRED_MODEL_ID = 'profile:v1-codea';
