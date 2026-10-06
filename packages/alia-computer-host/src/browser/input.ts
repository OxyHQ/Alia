/**
 * The whole vocabulary anyone — the agent or its owner — can speak to the
 * browser: a click at a point, typed text, one key from a short list, a scroll.
 *
 * There is deliberately no "evaluate this JavaScript", no selector, no file
 * chooser and no arbitrary key chord. Each of those is a way to act on a page
 * that the screenshot does not show, and the screenshot is what the owner
 * watches. The page's text and its clickable elements are read by a fixed
 * function in the worker (`pool.ts`), never by caller-supplied code.
 *
 * Shared by the control API (which refuses early) and the worker (which
 * refuses again — it is the last line, and trusts nothing it is sent).
 */
import { z } from 'zod';

export const VIEWPORT = { width: 1280, height: 800 } as const;

/** Keys a form needs, and nothing that reaches the browser's own UI. */
export const ALLOWED_KEYS = [
  'Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'Control+a', 'Meta+a',
] as const;

export type AllowedKey = (typeof ALLOWED_KEYS)[number];

export const MAX_TYPED_CHARACTERS = 2000;
export const MAX_SCROLL_PIXELS = 5000;

const coordinate = (max: number) => z.number().int().min(0).max(max - 1);

export const browserInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: coordinate(VIEWPORT.width), y: coordinate(VIEWPORT.height) }).strict(),
  z.object({ type: z.literal('type'), text: z.string().min(1).max(MAX_TYPED_CHARACTERS) }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(ALLOWED_KEYS) }).strict(),
  z.object({
    type: z.literal('scroll'),
    deltaY: z.number().int().min(-MAX_SCROLL_PIXELS).max(MAX_SCROLL_PIXELS),
    deltaX: z.number().int().min(-MAX_SCROLL_PIXELS).max(MAX_SCROLL_PIXELS).optional(),
  }).strict(),
]);

export type BrowserInput = z.infer<typeof browserInputSchema>;

/** Who is acting. The owner taking over is how logins and captchas get done. */
export const actorRoleSchema = z.enum(['agent', 'owner']);
export type ActorRole = z.infer<typeof actorRoleSchema>;

/** Playwright's spelling of an allowed key. */
export function playwrightKey(key: AllowedKey): string {
  return key === 'Space' ? ' ' : key;
}

/** What a receipt may say about an input: its kind, never the typed text. */
export function describeInput(input: BrowserInput): string {
  switch (input.type) {
    case 'click':
      return `click ${input.x},${input.y}`;
    case 'type':
      return `type ${input.text.length} characters`;
    case 'key':
      return `key ${input.key}`;
    case 'scroll':
      return `scroll ${input.deltaX ?? 0},${input.deltaY}`;
  }
}
