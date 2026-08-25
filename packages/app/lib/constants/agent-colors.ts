/**
 * The colours an agent may be given, as the picker offers them.
 *
 * ## Why this is not `FREE_COLOR_NAMES`
 *
 * It was, and 52 of the 61 it offered could not be saved. The colour goes to
 * Oxy in `UpdateAccountInput.color` and lands in `users.color`, which carries
 * the CHECK constraint `users_color_check` — eleven preset keys. Bloom's free
 * list is sixty-one. Every key in the difference is a 400 on a swatch the
 * person was shown, and nothing in the app could tell them apart: they all
 * render, because Bloom knows them all.
 *
 * So the vocabulary is the INTERSECTION of the two lists, and it is nine:
 * storable by Oxy and paintable by Bloom. Neither half is negotiable —
 * `amber` is in the constraint but in no Bloom palette, so it would save and
 * then draw in the fallback colour, which is the same bug seen from the other
 * side.
 *
 * The premium preset and the reserved handle colours (`oxy`, `faircoin`) need
 * no rule here: they are absent from `FREE_COLOR_NAMES`, so the intersection
 * excludes them on its own.
 *
 * ## Kept in step with the generator by a gate, not by care
 *
 * `packages/api/src/domain/agent-color.ts` declares the same nine for
 * `POST /agents/generate`, because the API cannot import Bloom — it is a React
 * Native package — and this app cannot import the API. Two declarations of one
 * vocabulary is how they drifted apart in the first place, so
 * `scripts/check-agent-colour-vocabulary.mjs` fails if they stop matching each
 * other or stop being exactly the intersection above. Adding a colour to one
 * list and not the other is red, not a surprise six months later.
 */
export const AGENT_SWATCHES = [
  'teal',
  'blue',
  'green',
  'red',
  'purple',
  'pink',
  'sky',
  'orange',
  'mint',
] as const;
