/**
 * The handful of values the composer's parts share now that there is no
 * composer component to hold them.
 *
 * `components/ui/prompt-input/context.tsx` used to be this file plus a React
 * context, and the context was the problem: every part of the bar read its
 * state out of an ambient object, so a tile could not be mounted without a
 * provider and a provider could not be built without casting a partial object
 * through `as unknown as PromptInputContextType` — which every test in that
 * directory did, and which is how a required field came to be `undefined` at
 * runtime in a tree TypeScript had called safe.
 *
 * Bloom's pill owns the field, the add menu, the model menu, the mic and the
 * send control, and it takes them all as props. What is left over — the
 * attachment strip, the drop overlay, the suggestion list — is composed as its
 * SIBLINGS, and siblings talk through props. So this file carries no context,
 * no provider and no hook: only the things two files genuinely have to agree
 * about.
 */

/**
 * The composer's outer corner — which is Bloom's number, not one of ours.
 *
 * `ComposerPillBase` is 52 tall at one line and rounds itself to `9999`, which
 * on a 52-tall box resolves to a 26px corner; past one line it stops being a
 * pill and squares off to a literal 26. So 26 is the corner the composer wears
 * in BOTH states, and the two layers that have to agree with it — the
 * `ComposerLoader` band tracing the outline, and the drop overlay covering it
 * — take it from here rather than each guessing.
 *
 * It used to be 28, a number Alia's own bar wore as `rounded-[28px]` and
 * nothing else knew about. That bar is gone; keeping its corner would have
 * meant a band and an overlay drawn 2px off the thing they are drawn on, for
 * no reason but inheritance.
 *
 * A number and not a class, because a radius is DERIVED from it (see below)
 * and a Tailwind class cannot be read back.
 */
export const COMPOSER_RADIUS = 26;

/**
 * How far the attachment row is inset from the composer's edge — the `px-5` on
 * its content container.
 */
export const ATTACHMENT_ROW_INSET = 20;

/**
 * A tile's corner, concentric with the composer's rather than a number of its
 * own: a rounded box nested inside another looks nested when its radius is the
 * outer one less the gap between them, and merely stuck on top when it is not.
 */
export const ATTACHMENT_TILE_RADIUS = COMPOSER_RADIUS - ATTACHMENT_ROW_INSET;

export interface Attachment {
  id: string;
  uri: string;
  type: "image" | "document";
  name: string;
  size: number;
  mimeType: string;
  isLoading?: boolean;
}
