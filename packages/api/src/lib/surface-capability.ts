/**
 * What a client surface can present to a person — epic #139 workstream 5,
 * *"filter the catalogue by Alia product policy, plan entitlement, region and
 * platform capability."*
 *
 * Of those four, three already had an answer and one had nothing. Product
 * policy is `lib/product-modes.ts`, plan entitlement is `lib/plan-access.ts`
 * read through `lib/catalogue.ts`, and REGION is deliberately absent —
 * `lib/routing/presets.ts` lists it in `DELEGATED_TO_KAANA` because a region
 * filter needs a catalogue that knows which deployment is where, and Alia has
 * none. `GET /catalogue` says so in its response rather than answering
 * "no region restriction", which is what a stub would answer and is
 * indistinguishable from a working filter with nothing to filter.
 *
 * Platform capability is the one of the four that is an ALIA-side fact: which
 * client is asking, and what that client can do with an answer. Nothing carried
 * it before this module.
 *
 * ## This table is a product decision, not a probe
 *
 * It records what Alia CHOOSES to offer on each surface. It is not a
 * measurement of what each client is technically capable of, and it must not be
 * read as one — a client that gains a microphone does not change this file, a
 * person does, in a commit. That is the same treatment `PRODUCT_MODES` and
 * `VISIBLE_PROFILES` get in `lib/product-modes.ts`, and it is why the audit
 * trail for all three is git: there is no table, no route and no writer.
 *
 * ## Why the surface is declared and not sniffed
 *
 * `?surface=` is a query parameter the caller states, exactly like `?product=`
 * and `?entitled=`. Deriving it from a `User-Agent` would be a guess that fails
 * closed on every client it did not recognise, and an unrecognised surface
 * silently receiving a narrowed catalogue is worse than one receiving all of
 * it. An unknown value is a 400, and no value at all applies no filter.
 */

/**
 * What a surface can carry, in both directions.
 *
 * Three rather than the five modalities `@oxyhq/contracts`
 * `inferenceModalitySchema` defines: `video` and `embedding` are not offered by
 * any Alia surface, and a vocabulary carrying values no entry can require and
 * no surface can hold would make the coverage assertions below vacuous.
 */
export const SURFACE_MODALITIES = ['text', 'image', 'audio'] as const;

export type SurfaceModality = (typeof SURFACE_MODALITIES)[number];

export interface SurfaceCapability {
  /**
   * The workspace this surface is, so the vocabulary is anchored to something
   * that exists — `lib/__tests__/surface-capability.test.ts` asserts every one
   * of these is a real directory. Without it the list is a set of names nothing
   * contradicts.
   *
   * It is an anchor and not a wire value: `GET /catalogue` echoes the surface
   * NAME a caller declared, so renaming a package cannot change an API
   * response. Written as a PATH rather than a bare directory name because four
   * of the seven directories are `alia-`-prefixed, and a bare `alia-console` in
   * product source is alias-shaped — gate 3 of `__tests__/architectureGates`
   * censuses every such literal, and it is right to: adding six workspace names
   * to its not-a-model exemption list is exactly how that list stops meaning
   * anything.
   */
  readonly workspace: string;
  readonly modalities: readonly SurfaceModality[];
}

/** A surface with the name a caller declares it by. */
export interface Surface extends SurfaceCapability {
  readonly name: string;
}

/**
 * Every surface a caller may declare.
 *
 * `text` appears on all of them: a surface that cannot render text is not a
 * chat client, and admitting one would make the whole filter meaningless
 * because every entry answers in text.
 */
export const SURFACE_CAPABILITIES: Readonly<Record<string, SurfaceCapability>> = {
  /** `packages/app` — the Expo client, web and native. Voice through LiveKit. */
  chat: { workspace: 'packages/app', modalities: ['text', 'image', 'audio'] },
  /** `packages/alia-chat`, published as `@alia.onl/sdk` and embedded by third parties. */
  embedded: { workspace: 'packages/alia-chat', modalities: ['text', 'image', 'audio'] },
  /** `packages/alia-cowork` — the Electron desktop client. */
  desktop: { workspace: 'packages/alia-cowork', modalities: ['text', 'image'] },
  /** `packages/alia-canvas` — the diagram and canvas editor. */
  canvas: { workspace: 'packages/alia-canvas', modalities: ['text', 'image'] },
  /** `packages/alia-codea` — the VS Code extension and its webview. */
  editor: { workspace: 'packages/alia-codea', modalities: ['text', 'image'] },
  /** `packages/alia-codea-cli` — the terminal client. */
  terminal: { workspace: 'packages/alia-codea-cli', modalities: ['text'] },
  /** `packages/alia-console` — the operator dashboard. */
  console: { workspace: 'packages/alia-console', modalities: ['text'] },
};

export const SURFACES: readonly string[] = Object.keys(SURFACE_CAPABILITIES).sort();

/**
 * What a catalogue entry's own category REQUIRES of the surface offering it.
 *
 * Keyed by the category vocabulary the alias set already uses. A `vision` entry
 * exists to be given an image and a `voice` entry exists to be spoken to, so a
 * surface that carries neither cannot offer them for what they are — which is
 * the *"a surface that cannot render audio does not receive an audio-only
 * entry"* property this filter is asked for.
 *
 * Deliberately NOT derived from the entry's computed `capabilities` block:
 * those say what a route SUPPORTS, and support is not requirement. Every entry
 * in the catalogue supports text, so a filter keyed on support would withhold
 * nothing from anybody.
 *
 * Declared here rather than imported from `internal/providers/lib/routing-profile-catalogue`,
 * because ADR 0001 keeps `lib/` out of that tree; the coverage is asserted in
 * both directions by the test, which holds the one allowlisted import.
 */
export const CATEGORY_REQUIREMENTS: Readonly<Record<string, readonly SurfaceModality[]>> = {
  general: ['text'],
  coding: ['text'],
  vision: ['image'],
  audio: ['audio'],
  voice: ['audio'],
  multimodal: ['image', 'audio'],
};

/**
 * Whether a surface may be offered an entry of this category.
 *
 * A category with no requirement entry is OFFERED, and that is the permissive
 * direction on purpose: withholding an entry from every surface because a new
 * category was added and this table was not is a product outage, where offering
 * it is at worst a client rendering something plainly. The coverage test is
 * what stops the gap existing, rather than a fail-closed default that would
 * hide the gap by making it look deliberate.
 */
export function surfaceCanOffer(surface: SurfaceCapability, category: string): boolean {
  if (!Object.hasOwn(CATEGORY_REQUIREMENTS, category)) return true;
  return CATEGORY_REQUIREMENTS[category].every((modality) => surface.modalities.includes(modality));
}

/**
 * The named surface, or `null` when nothing is named by that string.
 *
 * `Object.hasOwn` rather than a truthiness check on the lookup, because the
 * name comes off a query string: `?surface=constructor` finds
 * `Object.prototype.constructor` on a plain object literal and would resolve to
 * a function, which then reaches `surfaceCanOffer` as a surface. The same guard
 * is on the category lookup above for the same reason.
 */
export function getSurface(name: string): Surface | null {
  if (!Object.hasOwn(SURFACE_CAPABILITIES, name)) return null;
  return { name, ...SURFACE_CAPABILITIES[name] };
}
