/**
 * The model catalogue and the product modes, as the bots consume them
 * (`GET /catalogue`, `GET /catalogue/modes`, epic #139 workstream 5).
 *
 * ## Why this exists at all
 *
 * The Telegram and Discord bots read `GET /v1/models` and, when it came back
 * empty, printed `kaana-lite` — a routing profile wearing a model's name, and
 * the identifier ADR 0002 froze. `docs/migration/compatibility-window.md`
 * records that `/v1/models` is CLOSED FOR ADVERTISEMENT and permanently serves
 * `{"object":"list","data":[]}`, so "when it came back empty" is now always:
 * every `/model` listing was empty and every `/status` printed the alias.
 *
 * Measured 2026-08-19 against the running service:
 * `GET https://api.alia.onl/v1/models` → `{"object":"list","data":[]}`;
 * `GET https://api.alia.onl/catalogue` → twelve entries, all
 * `object: "routing_profile"`.
 *
 * ## Why `/catalogue` and not something under `/v1`
 *
 * CORS is not a factor for this service and auth is not either, which is the
 * whole reason the answer here differs from the browser clients'. This is a
 * server-to-server call with no `Origin` header, which `createOxyCors` passes
 * through untouched (`packages/api/src/index.ts`), and `GET /catalogue` is
 * `optionalAuth` while `GET /catalogue/modes` is unauthenticated outright. The
 * bots hold a channel secret and an Oxy user id, not the user's own bearer
 * token, so `?entitled=true` is not available to them — they offer what the
 * product advertises (`chat_visible`), which is what they offered before.
 *
 * No `?surface=` either: `lib/surface-capability.ts` names seven surfaces and
 * none of them is a chat bot, and an unrecognised value is a 400 rather than an
 * unfiltered list. `chat_visible` already narrows to the four general-purpose
 * profiles, which is the same set a text-only channel can render.
 *
 * ## What a person reads
 *
 * A routing profile is shown with the words of the product mode that selects it
 * — Fast, Balanced, Maximum quality — falling back to the catalogue's own
 * display name for a profile no mode names. That rule is stated once, at
 * length, in `packages/app/lib/hooks/use-product-modes.ts`; {@link presentation}
 * below is the same rule, and the reason it is a copy rather than an import is
 * that this service deploys separately and depends on no unpublished workspace
 * package.
 */

/** A catalogue entry, in the fields a bot renders or decides on. */
export interface CatalogueEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly emoji: string | null;
  readonly chatVisible: boolean;
  readonly unavailable: boolean;
  readonly creditMultiplier: number | null;
}

/** Which routing profile a request made in this mode goes through. */
export type ProductModeRouting = { readonly kind: 'profile'; readonly profileId: string };

export interface ProductMode {
  /** `mode:*`. Never sent as a request `model` — nothing in the request path consumes one. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly routing: ProductModeRouting;
  readonly deepResearch: boolean;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Turn a catalogue response into entries, or throw.
 *
 * Throwing beats returning an empty list because "no entries" and "we failed to
 * read the entries" are indistinguishable to the caller, and one of them means
 * a `/model` listing that silently offers nothing.
 */
export function parseCatalogue(payload: unknown): CatalogueEntry[] {
  const body = asObject(payload);
  const data = body === null ? null : body.data;
  if (!Array.isArray(data)) throw new Error('The model catalogue response could not be read.');

  const entries: CatalogueEntry[] = [];
  for (const value of data) {
    const raw = asObject(value);
    if (raw === null) continue;
    const id = asText(raw.id);
    const displayName = asText(raw.display_name);
    if (id === null || displayName === null) continue;
    // An entry whose `object` is neither known value is dropped rather than
    // guessed at: ADR 0003 reserves `model` for models, and a third value is a
    // shape this build has never seen.
    if (raw.object !== 'model' && raw.object !== 'routing_profile') continue;
    const availability = asObject(raw.availability) ?? {};
    const pricing = asObject(raw.pricing) ?? {};
    entries.push({
      id,
      displayName,
      description: asText(raw.description) ?? '',
      emoji: asText(raw.emoji),
      chatVisible: raw.chat_visible === true,
      unavailable: availability.status === 'unavailable',
      creditMultiplier: asNumber(pricing.credit_multiplier),
    });
  }
  if (data.length > 0 && entries.length === 0) {
    throw new Error('The model catalogue response could not be read.');
  }
  return entries;
}

function parseRouting(value: unknown): ProductModeRouting | null {
  const raw = asObject(value);
  if (raw === null) return null;
  if (raw.kind === 'profile') {
    const profileId = asText(raw.profile_id);
    if (profileId !== null && profileId !== '' && profileId.trim() === profileId) {
      return { kind: 'profile', profileId };
    }
  }
  return null;
}

/** Turn a modes response into modes, or throw — same reasoning as {@link parseCatalogue}. */
export function parseModes(payload: unknown): ProductMode[] {
  const body = asObject(payload);
  const data = body === null ? null : body.data;
  if (!Array.isArray(data)) throw new Error('The product modes response could not be read.');

  const modes: ProductMode[] = [];
  for (const value of data) {
    const raw = asObject(value);
    if (raw === null || raw.object !== 'product_mode') {
      throw new Error('The product modes response could not be read.');
    }
    const id = asText(raw.id);
    const label = asText(raw.label);
    const routing = parseRouting(raw.routing);
    if (
      id === null || id === '' || id.trim() !== id || !id.startsWith('mode:')
      || label === null || label === '' || label.trim() !== label
      || routing === null
    ) throw new Error('The product modes response could not be read.');
    modes.push({
      id,
      label,
      description: asText(raw.description) ?? '',
      routing,
      deepResearch: raw.deep_research === true,
    });
  }
  if (data.length > 0 && modes.length === 0) {
    throw new Error('The product modes response could not be read.');
  }
  return modes;
}

/** The product's word for a routing profile, or `null` when it has none. */
export function modeForProfile(
  profileId: string,
  modes: readonly ProductMode[],
): ProductMode | null {
  const expectedModeId: Record<string, string> = {
    'kaana-lite': 'mode:fast',
    'kaana-v1': 'mode:balanced',
    'kaana-v1-pro-max': 'mode:maximum-quality',
    'kaana-v1-codea': 'mode:coding',
  };
  const modeId = expectedModeId[profileId];
  if (modeId === undefined) return null;
  return modes.find((mode) => mode.id === modeId && mode.routing.profileId === profileId) ?? null;
}

/**
 * What a person reads for an entry: the product's word for it, or the
 * catalogue's own.
 *
 * The fallback is a real fallback rather than a formality — the capability
 * profiles (`profile:v1-vision` and the rest) have no mode, and inventing one
 * for them would be the same category error as the alias display names this
 * replaces, in the other direction.
 */
export function presentation(
  entry: CatalogueEntry,
  modes: readonly ProductMode[],
): { readonly label: string; readonly description: string } {
  const mode = modeForProfile(entry.id, modes);
  if (mode === null) return { label: entry.displayName, description: entry.description };
  return { label: mode.label, description: mode.description };
}

/** One row of a bot's `/model` listing. */
export interface OfferedMode {
  /** The `profile:*` identifier the bot stores and sends. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly emoji: string | null;
  readonly creditMultiplier: number | null;
}

/**
 * What a bot offers, in the product's words.
 *
 * `chat_visible` is the product's own visibility decision — it is
 * `isProfileOffered` on the server, keyed by profile — so this filter is read
 * off the response rather than reimplemented here.
 */
export function offeredModes(
  entries: readonly CatalogueEntry[],
  modes: readonly ProductMode[],
): OfferedMode[] {
  return entries
    .filter((entry) => entry.chatVisible)
    .map((entry) => {
      const { label, description } = presentation(entry, modes);
      return {
        id: entry.id,
        label,
        description,
        emoji: entry.emoji,
        creditMultiplier: entry.creditMultiplier,
      };
    });
}

/**
 * The mode that expresses no preference, selected by its exact product ID.
 * Profile identity is not inferred from default markers or response order.
 */
function automaticMode(modes: readonly ProductMode[]): ProductMode | null {
  return modes.find((mode) => mode.id === 'mode:automatic') ?? null;
}

/**
 * What a person's stored preference is CALLED, or `null` when the product has
 * no word for it.
 *
 * Three cases, and the third is the one that needs stating:
 *
 *  - no stored preference — the request names no model, which is precisely what
 *    the automatic mode is, so that mode's label is the honest answer rather
 *    than a stand-in for one;
 *  - a stored preference the catalogue describes — the product's word for it;
 *  - a stored preference the catalogue does NOT describe. That is a legacy
 *    `alia-*` identifier saved before `/v1/models` closed, and it keeps
 *    resolving on the server, so the request is unaffected. `null`, and the
 *    caller omits the row: printing the identifier is the defect this module
 *    removes, and substituting some other mode's label would claim a routing
 *    the request does not make. Deliberately NOT resolved through a
 *    `resolveSelection`-style replacement, which would report Fast for someone
 *    whose stored `kaana-v1-pro-max` still routes to maximum quality.
 */
export function labelForPreference(
  preferredModel: string | null | undefined,
  entries: readonly CatalogueEntry[],
  modes: readonly ProductMode[],
): string | null {
  if (preferredModel === null || preferredModel === undefined || preferredModel === '') {
    return automaticMode(modes)?.label ?? null;
  }
  const entry = entries.find((candidate) => candidate.id === preferredModel);
  if (entry === undefined) return null;
  return presentation(entry, modes).label;
}
