/**
 * The model catalogue, as the Electron main process consumes it (`GET /catalogue`).
 *
 * Alia has no models of its own. The catalogue lists real models, each
 * identified as `publisher/model`, and says which one the server answers a
 * request with when the request names none (`defaultModelId`). Cowork names no
 * model anywhere: what a request carries is either the person's choice, checked
 * against this list, or nothing at all — and "nothing" means the server default.
 *
 * ## Why this is a copy rather than a shared module
 *
 * `packages/app`, `@alia.onl/sdk` and `@alia-codea/cli` parse the same surface.
 * The SDK ships as RAW SOURCE and the CLI is published, so neither can depend
 * on an unpublished workspace package; a shared module only some consumers
 * could use is a copy with extra ceremony. The parsing rule is the same in all
 * of them: an entry that is not a `publisher/model` model is dropped, and a
 * response whose entries ALL fail to parse throws rather than reading as an
 * empty catalogue.
 */

export interface CatalogueModel {
  readonly id: string
  readonly name: string
  readonly publisher: { readonly id: string; readonly name: string }
  readonly description: string | null
  readonly contextWindow: number | null
  readonly reasoningEfforts: readonly ReasoningEffort[]
  readonly featured: boolean
}

export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface Catalogue {
  readonly models: readonly CatalogueModel[]
  /** What the server answers a request that names no model with; `null` if it did not say. */
  readonly defaultModelId: string | null
  readonly featuredIds: readonly string[]
}

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high']

/**
 * Whether a value has the shape of a catalogue id: `publisher/model`.
 *
 * Also what retires the identifiers earlier builds persisted as the stored
 * preference — product modes and routing profiles are `<kind>:<name>`, never
 * `publisher/model`, so they read as no preference at all.
 */
export function isModelId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const slash = value.indexOf('/')
  return slash > 0 && slash < value.length - 1 && !/\s/.test(value)
}

export function parseCatalogue(payload: unknown): Catalogue {
  const body = asObject(payload)
  const data = body === null ? null : body.data
  if (body === null || !Array.isArray(data)) {
    throw new Error('The model catalogue response could not be read.')
  }

  const models: CatalogueModel[] = []
  for (const value of data) {
    const raw = asObject(value)
    if (raw === null || raw.object !== 'model') continue
    const id = asText(raw.id)
    const name = asText(raw.name)
    const publisher = asObject(raw.publisher)
    const publisherId = publisher === null ? null : asText(publisher.id)
    const publisherName = publisher === null ? null : asText(publisher.name)
    if (!isModelId(id) || name === null || publisherId === null || publisherName === null) continue
    models.push({
      id,
      name,
      publisher: { id: publisherId, name: publisherName },
      description: asText(raw.description),
      contextWindow: asCount(raw.contextWindow),
      reasoningEfforts: Array.isArray(raw.reasoningEfforts)
        ? EFFORTS.filter((effort) => (raw.reasoningEfforts as unknown[]).includes(effort))
        : [],
      featured: raw.featured === true
    })
  }
  if (data.length > 0 && models.length === 0) {
    throw new Error('The model catalogue response could not be read.')
  }

  return {
    models,
    defaultModelId: isModelId(body.defaultModelId) ? body.defaultModelId : null,
    featuredIds: Array.isArray(body.featuredIds) ? body.featuredIds.filter(isModelId) : []
  }
}

/**
 * The `model` a request should carry, or `undefined` to omit it and let the
 * server use its default.
 *
 *  - Nothing configured (or a retired non-model identifier) → omit.
 *  - Configured and listed by the loaded catalogue → send it.
 *  - Configured but no longer listed → omit: the server would refuse it, and
 *    its default is the honest answer to "the model you picked is gone".
 *  - Catalogue unreadable (`undefined`) → send the configured id as-is; the
 *    server stays the authority.
 */
export function resolveSelection(
  configuredId: string | null | undefined,
  catalogue: Catalogue | undefined
): string | undefined {
  if (!isModelId(configuredId)) return undefined
  if (catalogue === undefined) return configuredId
  return catalogue.models.some((model) => model.id === configuredId) ? configuredId : undefined
}

/** How long a fetched catalogue is reused: a desktop app stays open for days. */
const CACHE_TTL_MS = 60 * 60 * 1000

const cache = new Map<string, { at: number; request: Promise<Catalogue> }>()

/**
 * The catalogue for one API base URL, reused for an hour.
 *
 * A rejected promise is evicted at once, so an outage is not cached past itself.
 */
export function loadCatalogue(apiBaseUrl: string, accessToken?: string): Promise<Catalogue> {
  const cached = cache.get(apiBaseUrl)
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.request

  const request = (async () => {
    const response = await fetch(`${apiBaseUrl}/catalogue`, {
      headers: accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }
    })
    if (!response.ok) throw new Error(`The model catalogue request failed (${response.status}).`)
    return parseCatalogue(await response.json())
  })()

  cache.set(apiBaseUrl, { at: Date.now(), request })
  request.catch(() => cache.delete(apiBaseUrl))
  return request
}

async function readCatalogue(apiBaseUrl: string, accessToken?: string): Promise<Catalogue | undefined> {
  try {
    return await loadCatalogue(apiBaseUrl, accessToken)
  } catch {
    return undefined
  }
}

/** The `model` a chat request carries, or `undefined` to omit it. Never throws. */
export async function resolveModelId(
  apiBaseUrl: string,
  configuredId: string | null | undefined,
  accessToken?: string
): Promise<string | undefined> {
  return resolveSelection(configuredId, await readCatalogue(apiBaseUrl, accessToken))
}

/**
 * The model for a caller that cannot omit one — the browser agent, whose
 * third-party library requires a model name on every request.
 *
 * The person's choice if the catalogue lists it, else the model the server
 * itself names as its default. `null` when neither is known: a catalogue that
 * could not be read and no choice made, which the caller reports rather than
 * guessing a model.
 */
export async function resolveRequiredModelId(
  apiBaseUrl: string,
  configuredId: string | null | undefined,
  accessToken?: string
): Promise<string | null> {
  const catalogue = await readCatalogue(apiBaseUrl, accessToken)
  return resolveSelection(configuredId, catalogue) ?? catalogue?.defaultModelId ?? null
}
