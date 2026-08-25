import { APP_COLOR_PRESETS, parseRgb, type AppColorName } from '@oxyhq/bloom/theme';

/**
 * The Bloom preset an agent's colour names, or nothing.
 *
 * `User.color` on an agent's Oxy bot account holds a preset KEY — the word
 * `"violet"`, not a colour — and this is the one place that decides whether a
 * given key is real. Two answers to that question is not a hypothetical
 * failure: it is what painted every coloured agent grey for a morning, when the
 * glyph validated the word with `parseRgb` and got `null` for a value that was
 * never a colour to begin with.
 *
 * Validated against Bloom's own table rather than a list kept here. A key
 * withdrawn from a future Bloom stops resolving on its own, which is what
 * should happen to a colour that no longer exists — and a list would have to be
 * remembered instead. There is a second, smaller set of keys the SERVER accepts
 * on a write; that is `POST /agents/generate`'s business, and asking about it
 * here would be a third answer to a question this file already answers.
 *
 * `Object.hasOwn`, not `in`: `'constructor' in APP_COLOR_PRESETS` is TRUE, so
 * `in` hands back `"constructor"` as a preset name and whatever receives it
 * looks up a FUNCTION where a recipe should be. The column is free text that
 * nobody validates — the API says so in as many words — so that string is
 * reachable, and a check written the obvious way lets it through.
 *
 * Absent, unresolved or unknown are ONE answer, `undefined`, and it is ordinary
 * traffic: the identity lookup behind these fields fails open, so an account
 * Oxy cannot resolve arrives with no colour at all. Callers treat `undefined`
 * as "inherit whatever the app already looks like".
 */
export function agentColorPreset(color: string | null | undefined): AppColorName | undefined {
  if (color === null || color === undefined) return undefined;
  return Object.hasOwn(APP_COLOR_PRESETS, color) ? (color as AppColorName) : undefined;
}

/**
 * The colour to paint an agent's mark in.
 *
 * `IdentityMark` takes a colour and nothing else — Alia's and an agent's are the
 * same artwork at the same size — so the agent's end of that has to be resolved
 * before it gets there, and this is where. Every call site that draws an agent
 * goes through it, so no two of them can pick a different colour for the same
 * agent.
 *
 * Two vocabularies, in the order they occur. A preset KEY is what Oxy stores and
 * what Alia's generator proposes, resolved by `agentColorPreset` above. A
 * literal colour is what anything else that has ever written to that free-text
 * column would have put there, and it is checked with `parseRgb` rather than
 * passed through: an SVG `fill` that SVG cannot parse renders BLACK, so a
 * garbage value would paint a black flower on every theme, silently, and look
 * like a design choice.
 *
 * Anything that is neither — including the absent colour an identity lookup that
 * failed open hands back, which is ordinary traffic rather than an error — takes
 * the theme's own muted foreground. Deliberately NOT `IdentityMark`'s default,
 * which is the Alia brand purple: an agent nobody could resolve must not end up
 * wearing Alia's face.
 */
export function agentTint(
  color: string | null | undefined,
  colors: { mutedForeground: string },
): string {
  const preset = agentColorPreset(color);
  if (preset !== undefined) return APP_COLOR_PRESETS[preset].hex;
  if (color !== null && color !== undefined && parseRgb(color) !== null) return color;
  return colors.mutedForeground;
}
