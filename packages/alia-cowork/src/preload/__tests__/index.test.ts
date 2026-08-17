import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The preload bridge's unsubscribes actually unsubscribe.
 *
 * ## Why this test exists at all
 *
 * A no-op unsubscribe is invisible by construction. Nothing throws, nothing
 * warns, the handler keeps working, and the only symptom is that it ALSO keeps
 * working after the caller asked it to stop — so a duplicate arrives for every
 * re-subscribe the window has ever done. Nine of these shipped in this file, and
 * the tenth (`window.electron.off`) type-checked cleanly and would have survived
 * any typecheck-only gate.
 *
 * ## Why the fake `ipcRenderer` is a real EventEmitter
 *
 * Because the property under test IS EventEmitter identity semantics:
 * `removeListener` matches the function you pass against the function you
 * registered. A hand-written stub that recorded `on`/`removeListener` calls
 * would let this file assert that the bridge called the right method with the
 * right argument — which is a statement about my own re-implementation, not
 * about whether the listener is gone. `EventEmitter` is what `ipcRenderer`
 * extends, so `listenerCount` here means what it means in Electron.
 *
 * ## The census
 *
 * The `on*` methods are enumerated off the exposed object rather than listed, so
 * a thirteenth subscriber added later is covered the day it is written. The
 * channel each one uses is discovered by diffing `eventNames()` across the
 * subscribe call, so this file holds no channel map to fall out of date either.
 */

const ipcRenderer = new EventEmitter() as EventEmitter & {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}
ipcRenderer.invoke = () => Promise.resolve(undefined)

const exposed = new Map<string, Record<string, unknown>>()

vi.mock('electron', () => ({
  ipcRenderer,
  contextBridge: {
    exposeInMainWorld: (key: string, value: Record<string, unknown>): void => {
      exposed.set(key, value)
    },
  },
}))

type Unsubscribe = () => void
type Subscriber = (callback: (...args: unknown[]) => void) => Unsubscribe
type ElectronBridge = {
  on: (channel: string, callback: (...args: unknown[]) => void) => void
  off: (channel: string, callback: (...args: unknown[]) => void) => void
}

let api: Record<string, unknown>
let electron: ElectronBridge

beforeEach(async () => {
  ipcRenderer.removeAllListeners()
  exposed.clear()
  // Re-imported per test so the bridge's own module state — the `(channel,
  // callback) -> wrapper` map behind `electron.off` — starts empty. A test that
  // inherited it could pass on a stale entry left by an earlier one.
  vi.resetModules()
  await import('../index.js')
  api = exposed.get('api') ?? {}
  electron = (exposed.get('electron') ?? {}) as ElectronBridge
})

afterEach(() => {
  // The property under test, restated as a global invariant: no test may leave a
  // listener behind. If one does, either the test forgot to clean up or an
  // unsubscribe silently did nothing — which is the bug.
  expect(ipcRenderer.eventNames(), 'a listener survived the test').toEqual([])
})

/** Subscribe through `method`, and report which channel it registered on. */
function subscribeVia(method: Subscriber, callback: (...args: unknown[]) => void): {
  readonly unsubscribe: Unsubscribe
  readonly channel: string
} {
  const before = new Set(ipcRenderer.eventNames().map(String))
  const unsubscribe = method(callback)
  const added = ipcRenderer.eventNames().map(String).filter((name) => !before.has(name))
  // One and only one channel: a subscriber that registered on two would leave
  // one behind however carefully the other was removed.
  expect(added, 'the subscriber did not register exactly one new channel').toHaveLength(1)
  return { unsubscribe, channel: added[0] }
}

describe('the preload bridge exposes what the renderer expects', () => {
  it('exposes both bridges, and enough subscribers for the census to mean something', () => {
    expect([...exposed.keys()].sort()).toEqual(['api', 'electron'])
    const subscribers = Object.keys(api).filter((key) => key.startsWith('on'))
    // The vacuity floor. An empty list satisfies every "each one unsubscribes"
    // assertion below, and a renamed export or a failed mock produces exactly
    // that.
    expect(subscribers.length).toBe(12)
  })
})

describe('every window.api subscriber returns an unsubscribe that works', () => {
  const subscriberNames = (): string[] => Object.keys(api).filter((key) => key.startsWith('on'))

  it('delivers while subscribed and stops after unsubscribing', () => {
    for (const name of subscriberNames()) {
      const received: unknown[] = []
      const { unsubscribe, channel } = subscribeVia(api[name] as Subscriber, (...args) => {
        received.push(args[0])
      })

      ipcRenderer.emit(channel, {}, { probe: name })
      expect(received, `${name} did not deliver while subscribed`).toHaveLength(1)

      unsubscribe()

      // Both halves. `listenerCount` is the leak; the second emit is the
      // behaviour a user would notice. A fix that removed SOME other listener
      // would satisfy one of these and not the other.
      expect(ipcRenderer.listenerCount(channel), `${name} leaked a listener`).toBe(0)
      ipcRenderer.emit(channel, {}, { probe: name })
      expect(received, `${name} still fired after unsubscribing`).toHaveLength(1)
    }
  })

  it('strips the IpcRendererEvent, so the renderer sees its payload first', () => {
    // The reason every subscriber wraps rather than registering the callback
    // directly — and therefore the reason the identity bug existed at all.
    const received: unknown[] = []
    const { unsubscribe, channel } = subscribeVia(api.onChatStream as Subscriber, (...args) => {
      received.push(args)
    })

    ipcRenderer.emit(channel, { senderId: 1 }, { content: 'hello' })
    expect(received).toEqual([[{ content: 'hello' }]])

    unsubscribe()
  })

  it('unsubscribes one of two identical subscriptions, leaving the other live', () => {
    // Two subscriptions with the SAME callback: the bug's worst case, because a
    // fix that removed listeners by callback identity would kill both, and a fix
    // that removed nothing would kill neither.
    let calls = 0
    const callback = (): void => {
      calls += 1
    }
    const first = subscribeVia(api.onChatEnd as Subscriber, callback)
    const second = api.onChatEnd as Subscriber
    const secondUnsubscribe = second(callback)

    expect(ipcRenderer.listenerCount(first.channel)).toBe(2)
    ipcRenderer.emit(first.channel, {})
    expect(calls).toBe(2)

    first.unsubscribe()
    expect(ipcRenderer.listenerCount(first.channel)).toBe(1)
    ipcRenderer.emit(first.channel, {})
    expect(calls).toBe(3)

    secondUnsubscribe()
    expect(ipcRenderer.listenerCount(first.channel)).toBe(0)
  })

  it('a zero-payload subscriber unsubscribes too', () => {
    // `onChatStart`, `onChatEnd` and `onAuthSignedOut` were NOT type errors:
    // passing the raw callback to both `on` and `removeListener` compiled and
    // worked. They are covered so the fix that put them through the same wrapper
    // cannot silently break them.
    for (const name of ['onChatStart', 'onChatEnd', 'onAuthSignedOut']) {
      let calls = 0
      const { unsubscribe, channel } = subscribeVia(api[name] as Subscriber, () => {
        calls += 1
      })
      ipcRenderer.emit(channel, {})
      expect(calls, `${name} did not deliver`).toBe(1)
      unsubscribe()
      ipcRenderer.emit(channel, {})
      expect(calls, `${name} still fired after unsubscribing`).toBe(1)
      expect(ipcRenderer.listenerCount(channel)).toBe(0)
    }
  })
})

describe('window.electron.off removes the listener window.electron.on added', () => {
  it('stops delivery and leaves no listener', () => {
    // The tenth no-op unsubscribe, and the one no typecheck would have caught:
    // `(...args: unknown[]) => void` is assignable to the listener type
    // `removeListener` accepts, so the old code compiled while removing nothing.
    let calls = 0
    const callback = (): void => {
      calls += 1
    }

    electron.on('browser:opened', callback)
    expect(ipcRenderer.listenerCount('browser:opened')).toBe(1)
    ipcRenderer.emit('browser:opened', {})
    expect(calls).toBe(1)

    electron.off('browser:opened', callback)
    expect(ipcRenderer.listenerCount('browser:opened'), 'electron.off left the listener behind').toBe(0)
    ipcRenderer.emit('browser:opened', {})
    expect(calls).toBe(1)
  })

  it('forwards every argument after the event', () => {
    const received: unknown[][] = []
    const callback = (...args: unknown[]): void => {
      received.push(args)
    }
    electron.on('browser:preview', callback)
    ipcRenderer.emit('browser:preview', { senderId: 1 }, 'a', 2)
    expect(received).toEqual([['a', 2]])
    electron.off('browser:preview', callback)
  })

  it('removes one registration per off, matching Node removeListener', () => {
    let calls = 0
    const callback = (): void => {
      calls += 1
    }
    electron.on('browser:closed', callback)
    electron.on('browser:closed', callback)
    expect(ipcRenderer.listenerCount('browser:closed')).toBe(2)

    electron.off('browser:closed', callback)
    expect(ipcRenderer.listenerCount('browser:closed')).toBe(1)
    ipcRenderer.emit('browser:closed', {})
    expect(calls).toBe(1)

    electron.off('browser:closed', callback)
    expect(ipcRenderer.listenerCount('browser:closed')).toBe(0)
  })

  it('an off for something never registered is a no-op, not a throw', () => {
    // The renderer's effect cleanups run on unmount paths that may not have
    // subscribed, so this has to be safe rather than defensive-looking.
    const callback = (): void => undefined
    expect(() => electron.off('never:registered', callback)).not.toThrow()
    electron.on('browser:error', callback)
    expect(() => electron.off('browser:error', () => undefined)).not.toThrow()
    expect(ipcRenderer.listenerCount('browser:error')).toBe(1)
    electron.off('browser:error', callback)
  })
})
