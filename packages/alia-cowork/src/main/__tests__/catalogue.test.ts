import { describe, expect, it } from 'vitest'
import { parseCatalogue, resolveSelection, type CatalogueEntry } from '../catalogue'
import { PREFERRED_BROWSER_MODEL_ID, PREFERRED_CHAT_MODEL_ID } from '../config'

/**
 * The model this app asks for is one the server accepts, and the resolver in
 * front of it substitutes only when the server would refuse.
 *
 * The catalogue payload is the shape `GET /catalogue` serves
 * (`packages/api/src/routes/catalogue.ts`): `route:*` ids, `object`,
 * `chat_visible`, `availability` and the `entitlement` block. Cowork's own
 * profile is published `chat_visible: false`, which is the case the previous
 * resolver got wrong.
 */

const CATALOGUE = {
  object: 'list',
  data: [
    {
      id: 'route:instant',
      display_name: 'Instant',
      chat_visible: true,
      object: 'routing_profile',
      availability: { status: 'available' },
      entitlement: { state: 'known', entitled: true },
    },
    {
      id: 'route:auto',
      display_name: 'Auto',
      chat_visible: true,
      object: 'routing_profile',
      availability: { status: 'available' },
      entitlement: { state: 'known', entitled: true },
    },
    {
      id: 'route:cowork',
      display_name: 'Cowork',
      chat_visible: false,
      object: 'routing_profile',
      availability: { status: 'available' },
      entitlement: { state: 'known', entitled: true },
    },
    {
      id: 'route:pro',
      display_name: 'Pro',
      chat_visible: true,
      object: 'routing_profile',
      availability: { status: 'available' },
      entitlement: { state: 'known', entitled: false, required_plan: 'Alia Pro' },
    },
    {
      id: 'mode:auto',
      object: 'product_mode',
      label: 'Auto',
    },
  ],
}

const entries = parseCatalogue(CATALOGUE)
const withEntitlement = (entitled: boolean | null): CatalogueEntry[] =>
  entries.map((entry) => ({ ...entry, entitled }))

describe('the build-time preferences', () => {
  it('are canonical routing profiles, which is the only spelling the request boundary accepts', () => {
    // `lib/product-modes.ts#toRoutingProfile` refuses `profile:*`; the
    // previous values were `profile:cowork` and `profile:research`.
    expect(PREFERRED_CHAT_MODEL_ID).toMatch(/^route:[a-z0-9-]+$/)
    expect(PREFERRED_BROWSER_MODEL_ID).toMatch(/^route:[a-z0-9-]+$/)
  })
})

describe('parseCatalogue', () => {
  it('reads entitlement and drops entries that are not models or routing profiles', () => {
    expect(entries.map((entry) => entry.id)).toEqual(['route:instant', 'route:auto', 'route:cowork', 'route:pro'])
    expect(entries.find((entry) => entry.id === 'route:cowork')).toMatchObject({ chatVisible: false, entitled: true })
    expect(entries.find((entry) => entry.id === 'route:pro')).toMatchObject({ entitled: false })
  })

  it('reads a missing or unknown entitlement as null, never as false', () => {
    const [entry] = parseCatalogue({
      object: 'list',
      data: [{ id: 'route:x', display_name: 'X', chat_visible: true, object: 'routing_profile', entitlement: { state: 'unknown' } }],
    })
    expect(entry.entitled).toBeNull()
  })
})

describe('resolveSelection', () => {
  it('honours the Cowork preset although it is not chat-visible', () => {
    expect(resolveSelection('route:cowork', entries)).toEqual({
      requestedId: 'route:cowork',
      effectiveId: 'route:cowork',
      source: 'requested',
    })
  })

  it('replaces an identifier the catalogue does not list with the preference', () => {
    // A stale `profile:cowork` persisted by an earlier build, for instance.
    expect(resolveSelection('profile:cowork', entries, 'route:cowork')).toEqual({
      requestedId: 'profile:cowork',
      effectiveId: 'route:cowork',
      source: 'replaced',
    })
  })

  it('replaces an entry this caller is not entitled to rather than sending it to a 403', () => {
    expect(resolveSelection('route:pro', entries, 'route:cowork').effectiveId).toBe('route:cowork')
    // ...and when the preference is not entitled either, the first entitled
    // chat-visible entry.
    const coworkLocked = entries.map((entry) => (entry.id === 'route:cowork' ? { ...entry, entitled: false } : entry))
    expect(resolveSelection('route:cowork', coworkLocked, 'route:cowork').effectiveId).toBe('route:instant')
  })

  it('treats unknown entitlement as no information', () => {
    expect(resolveSelection('route:pro', withEntitlement(null), 'route:cowork').effectiveId).toBe('route:pro')
  })

  it('leaves the request alone with no catalogue, or with nothing usable in it', () => {
    expect(resolveSelection('route:cowork', undefined).source).toBe('requested')
    expect(resolveSelection('route:nothing', withEntitlement(false)).effectiveId).toBe('route:nothing')
  })
})
