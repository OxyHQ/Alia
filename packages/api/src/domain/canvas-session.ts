/**
 * Closed value set and stored shape for `canvas-session`.
 *
 * These live OUTSIDE `models/` for the reason every other file in this
 * directory does: the drizzle schema depends on them at runtime, so deleting
 * the Mongoose model must not take them with it.
 *
 * `CANVAS_COMPONENT_TYPES` was declared twice before this port — once in the
 * model and once as an inline `z.enum([...])` in `lib/tools/canvas.ts`, which is
 * the tool that MINTS a component. Two literals for one vocabulary is how a
 * stored value ends up rejected by the writer that produced it, so the tool now
 * reads this tuple. The `EVENT_STREAM_ENTRY_TYPES` call, one domain over.
 */

/**
 * Exported as a TUPLE, not a union type: `lib/tools/canvas.ts` builds its
 * `z.enum` from these exact values.
 *
 * There is deliberately NO CHECK constraint behind it. `components` is one
 * `jsonb` array rather than a child table — `routes/canvas/sessions.ts` returns
 * it verbatim and nothing addresses an element — and Postgres cannot constrain a
 * field inside a jsonb document without a hand-written expression that would be
 * the only one of its kind in this schema.
 */
export const CANVAS_COMPONENT_TYPES = [
  'chart',
  'table',
  'code',
  'form',
  'image',
  'markdown',
  'artifact',
] as const;
export type CanvasComponentType = (typeof CANVAS_COMPONENT_TYPES)[number];

/**
 * One component inside a canvas session's `components` array.
 *
 * `data` is per-type and shaped by whichever tool call produced it — a chart's
 * datasets, a table's rows, a code block's language — so it stays open. It was
 * `Schema.Types.Mixed` in Mongoose for the same reason.
 *
 * `createdAt` is a `string` rather than a `Date`: this shape describes what is
 * IN the jsonb column, and JSON has no date type, so a row read back hands over
 * whatever the writer serialised. Typing it `Date` would be a claim the driver
 * does not honour — the `timestamptz` columns beside it are where a real `Date`
 * lives.
 */
export interface CanvasComponent {
  id: string;
  type: CanvasComponentType;
  title: string;
  data: unknown;
  createdAt: string;
}
