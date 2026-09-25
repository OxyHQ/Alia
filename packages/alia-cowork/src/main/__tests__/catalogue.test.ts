import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isModelId,
  loadCatalogue,
  parseCatalogue,
  resolveModelId,
  resolveRequiredModelId,
  resolveSelection
} from '../catalogue'

/**
 * Cowork names no model. A request carries the person's pick when the
 * catalogue lists it and omits `model` otherwise, so the server's default
 * answers; only an unreadable catalogue lets a pick through unchecked. The
 * fixture ids are invented on purpose — they only have to be `publisher/model`.
 */

const model = (over: Record<string, unknown> = {}) => ({
  id: 'acme/rocket-1',
  object: 'model',
  name: 'Rocket 1',
  publisher: { id: 'acme', name: 'Acme' },
  description: null,
  contextWindow: 200_000,
  maxOutput: null,
  inputModalities: ['text'],
  outputModalities: ['text'],
  tools: true,
  reasoningEfforts: ['low', 'high', 'extreme'],
  pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
  releasedAt: null,
  featured: false,
  ...over
})

const BODY = {
  object: 'list',
  data: [model(), model({ id: 'zeta/bolt', name: 'Bolt', publisher: { id: 'zeta', name: 'Zeta' }, featured: true })],
  defaultModelId: 'zeta/bolt',
  featuredIds: ['zeta/bolt']
}

const catalogue = parseCatalogue(BODY)

describe('parseCatalogue', () => {
  it('reads models, the server default and the featured ids', () => {
    expect(catalogue.models.map((entry) => entry.id)).toEqual(['acme/rocket-1', 'zeta/bolt'])
    expect(catalogue.defaultModelId).toBe('zeta/bolt')
    expect(catalogue.featuredIds).toEqual(['zeta/bolt'])
    expect(catalogue.models[0]).toMatchObject({
      name: 'Rocket 1',
      publisher: { id: 'acme', name: 'Acme' },
      contextWindow: 200_000,
      reasoningEfforts: ['low', 'high'],
      featured: false
    })
  })

  it('drops entries that are not `publisher/model` models', () => {
    const parsed = parseCatalogue({
      ...BODY,
      data: [model(), model({ id: 'no-slash' }), model({ object: 'routing_profile', id: 'x/y' }), model({ publisher: null })]
    })
    expect(parsed.models.map((entry) => entry.id)).toEqual(['acme/rocket-1'])
  })

  it('throws on an unreadable response rather than reading it as an empty catalogue', () => {
    expect(() => parseCatalogue({ nope: true })).toThrow('could not be read')
    expect(() => parseCatalogue({ object: 'list', data: [{ id: 'a/b' }] })).toThrow('could not be read')
    expect(parseCatalogue({ object: 'list', data: [] })).toEqual({ models: [], defaultModelId: null, featuredIds: [] })
  })
})

describe('resolveSelection', () => {
  it('sends a pick the catalogue lists', () => {
    expect(resolveSelection('acme/rocket-1', catalogue)).toBe('acme/rocket-1')
  })

  it('omits the model when nothing is picked, so the server default answers', () => {
    expect(resolveSelection(undefined, catalogue)).toBeUndefined()
    expect(resolveSelection(null, catalogue)).toBeUndefined()
    expect(resolveSelection('', catalogue)).toBeUndefined()
  })

  it('omits a pick the catalogue no longer lists', () => {
    expect(resolveSelection('gone/model', catalogue)).toBeUndefined()
  })

  it('treats a retired non-model identifier an earlier build stored as no pick', () => {
    for (const retired of ['route' + ':cowork', 'mode' + ':auto', 'profile' + ':research']) {
      expect(isModelId(retired)).toBe(false)
      expect(resolveSelection(retired, catalogue)).toBeUndefined()
      expect(resolveSelection(retired, undefined)).toBeUndefined()
    }
  })

  it('sends the pick as-is when the catalogue could not be read', () => {
    expect(resolveSelection('gone/model', undefined)).toBe('gone/model')
    expect(resolveSelection(undefined, undefined)).toBeUndefined()
  })
})

describe('fetching', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stubFetch = (response: () => Response | Promise<Response>) => {
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('resolves against the fetched catalogue, and caches it per base URL', async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify(BODY), { status: 200 }))
    const base = 'https://cache.test'
    expect(await resolveModelId(base, 'acme/rocket-1', 'token')).toBe('acme/rocket-1')
    expect(await resolveModelId(base, 'gone/model', 'token')).toBeUndefined()
    await loadCatalogue(base)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(`${base}/catalogue`, { headers: { Authorization: 'Bearer token' } })
  })

  it('never throws: an unreachable catalogue leaves the pick alone, and is not cached', async () => {
    const fetchMock = stubFetch(() => new Response('down', { status: 503 }))
    const base = 'https://down.test'
    expect(await resolveModelId(base, 'gone/model')).toBe('gone/model')
    expect(await resolveModelId(base, undefined)).toBeUndefined()
    await Promise.resolve()
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('gives a caller that cannot omit a model the pick, else the server-named default', async () => {
    stubFetch(() => new Response(JSON.stringify(BODY), { status: 200 }))
    expect(await resolveRequiredModelId('https://required.test', 'acme/rocket-1')).toBe('acme/rocket-1')
    expect(await resolveRequiredModelId('https://required.test', undefined)).toBe('zeta/bolt')
    expect(await resolveRequiredModelId('https://required.test', 'gone/model')).toBe('zeta/bolt')
  })

  it('reports no model for such a caller when neither a pick nor the catalogue is known', async () => {
    stubFetch(() => new Response('down', { status: 503 }))
    expect(await resolveRequiredModelId('https://required-down.test', undefined)).toBeNull()
    expect(await resolveRequiredModelId('https://required-down.test', 'acme/x')).toBe('acme/x')
  })
})
