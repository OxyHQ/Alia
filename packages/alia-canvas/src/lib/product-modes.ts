/**
 * How a workflow node asks Alia to answer (`GET /catalogue`,
 * `GET /catalogue/modes`, epic #139 workstream 5).
 *
 * ## What this replaces, and why it was a live defect rather than a latent one
 *
 * `src/lib/models.ts` hardcoded `{ id: "kaana-lite", name: "Kaana Lite" }` and the
 * edit panel rendered it under the label "Model". Its `fetchModels()` read
 * `GET /v1/models` — but nothing ever called it: the panel imported the static
 * `MODELS` export. So the alias name was not a fallback that fired during an
 * outage, it was the only thing the editor ever showed, and the badge above it
 * read `openai` because `data.provider` is never set on any node.
 *
 * `docs/migration/compatibility-window.md` records that `GET /v1/models` is
 * CLOSED FOR ADVERTISEMENT and permanently serves `{"object":"list","data":[]}`,
 * so wiring `fetchModels()` up would have replaced one wrong answer with an
 * empty one.
 *
 * ## Why the catalogue, and what has to be true for it to be reachable
 *
 * `GET /catalogue` and `GET /catalogue/modes` are the product surfaces and both
 * are populated. They sit on Alia's INTERNAL CORS allowlist rather than on the
 * `origin: '*'` one `/v1` gets (`packages/api/src/index.ts`), so this app's own
 * origin has to be on that allowlist for a browser to read either. Measured
 * 2026-08-19 against the running API: `Origin: https://alia.onl` gets an
 * `access-control-allow-origin` back from `/catalogue`, and
 * `Origin: https://alia-canvas.pages.dev` — the Cloudflare Pages default this
 * app was reachable on before it got its own domain — got none, so the read was
 * refused. It is served on `canvas.alia.onl` now, and only that origin is
 * admitted.
 *
 * The failure mode if that is ever wrong again is deliberate and safe: the
 * query fails, the picker offers Automatic alone, and every node runs on the
 * server's own default. Nothing shows an identifier either way.
 *
 * ## A mode is a LABEL for a profile, not a selectable identifier
 *
 * Nothing in the request path consumes a `mode:*` id, so what a node stores is
 * the `profile:*` identifier the catalogue publishes, or nothing at all for
 * Automatic. The rule is stated once, at length, in
 * `packages/app/lib/hooks/use-product-modes.ts`.
 */

import { useQuery } from '@tanstack/react-query';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4150';

/**
 * The picker value standing for "no explicit choice".
 *
 * A node in this mode carries NO `model` field, and the server routes it
 * through its own default — which is exactly what the Automatic product mode
 * is. It needs a non-empty value of its own because a Radix `Select.Item`
 * cannot hold the empty string, and it is deliberately not shaped like an
 * identifier so `scripts/check-model-defaults.mjs` does not have to make an
 * exception for it.
 */
export const AUTOMATIC = 'automatic';

/** Which routing profile a request made in this mode goes through. */
export type ProductModeRouting = { readonly kind: 'profile'; readonly profileId: string };

export interface ProductMode {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly routing: ProductModeRouting;
  readonly deepResearch: boolean;
}

interface CatalogueEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly chatVisible: boolean;
}

/** One row of the picker: what a node stores, and the words a person reads. */
export interface OfferedMode {
  readonly id: string;
  readonly label: string;
  readonly description: string;
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

/**
 * Turn a catalogue response into entries, or throw.
 *
 * Throwing beats returning an empty list: "the product offers nothing" and "we
 * could not read the response" are different answers, and only one of them
 * should silently reduce the picker to Automatic.
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
    if (raw.object !== 'model' && raw.object !== 'routing_profile') continue;
    entries.push({
      id,
      displayName,
      description: asText(raw.description) ?? '',
      chatVisible: raw.chat_visible === true,
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

/**
 * What a person reads for an entry: the product's word for it, or the
 * catalogue's own.
 *
 * The `displayName` fallback is real rather than a formality — the capability
 * profiles have no mode, and inventing one would be the same category error as
 * the alias display names this replaces.
 */
function presentation(
  entry: CatalogueEntry,
  modes: readonly ProductMode[],
): { readonly label: string; readonly description: string } {
  const expectedModeId: Record<string, string> = {
    'kaana-lite': 'mode:fast',
    'kaana-v1': 'mode:balanced',
    'kaana-v1-pro-max': 'mode:maximum-quality',
    'kaana-v1-codea': 'mode:coding',
  };
  const modeId = expectedModeId[entry.id];
  const mode = modeId === undefined
    ? null
    : modes.find((candidate) => candidate.id === modeId && candidate.routing.profileId === entry.id) ?? null;
  if (mode === null) return { label: entry.displayName, description: entry.description };
  return { label: mode.label, description: mode.description };
}

/**
 * The rows the picker offers: Automatic first, then what the product advertises.
 *
 * Automatic leads because it is the state a node starts in, and because it is
 * the only row that is a real product concept rather than a profile — it is the
 * absence of a choice, named. Its words come from the modes response like every
 * other row's, so nothing here writes the product's copy.
 */
export function offeredModes(
  entries: readonly CatalogueEntry[],
  modes: readonly ProductMode[],
): OfferedMode[] {
  const automatic = modes.find((mode) => mode.id === 'mode:automatic');
  const rows = entries
    .filter((entry) => entry.chatVisible)
    .map((entry) => ({ id: entry.id, ...presentation(entry, modes) }));
  if (automatic === undefined) return rows;
  return [
    { id: AUTOMATIC, label: automatic.label, description: automatic.description },
    ...rows,
  ];
}

async function readJson(path: string): Promise<unknown> {
  const response = await fetch(`${API_URL}${path}`);
  if (!response.ok) throw new Error(`The request to ${path} failed (${response.status}).`);
  return response.json();
}

/**
 * What a node may be set to, and what each is called.
 *
 * Unauthenticated: `GET /catalogue` is `optionalAuth` and `GET /catalogue/modes`
 * takes no credential, and the only annotation this app reads — `chat_visible`
 * — is the same for everybody. An empty result on failure, so the caller renders
 * Automatic alone rather than an identifier.
 */
export function useOfferedModes() {
  return useQuery<OfferedMode[]>({
    queryKey: ['catalogue', 'offered-modes'],
    queryFn: async () => {
      const [catalogue, modes] = await Promise.all([
        readJson('/catalogue'),
        readJson('/catalogue/modes'),
      ]);
      return offeredModes(parseCatalogue(catalogue), parseModes(modes));
    },
    staleTime: 1000 * 60 * 60,
    retry: 2,
  });
}

/**
 * The words for what a node is currently set to.
 *
 * `null` when the modes have not loaded or when the node names something the
 * product has no word for — a `model` saved into a workflow before this change,
 * which still routes on the server. The caller shows nothing rather than the
 * identifier, which is the defect this module removes.
 */
export function labelForNode(
  modelId: string | undefined,
  offered: readonly OfferedMode[] | undefined,
): string | null {
  if (offered === undefined) return null;
  const wanted = modelId === undefined || modelId === '' ? AUTOMATIC : modelId;
  return offered.find((mode) => mode.id === wanted)?.label ?? null;
}
