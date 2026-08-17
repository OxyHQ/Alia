import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/** A file/folder context item attached to a chat message. */
interface ContextItem {
  type: 'file' | 'folder'
  path: string
  content?: string
  language?: string
}

/**
 * Subscribe to `channel`, and return an unsubscribe that removes the listener
 * that was ACTUALLY REGISTERED.
 *
 * `ipcRenderer` is an EventEmitter, so `removeListener` matches on function
 * IDENTITY. Every subscriber below used to hand `ipcRenderer.on` a wrapper that
 * strips the leading `IpcRendererEvent` and then return
 * `() => ipcRenderer.removeListener(channel, callback)` — the caller's own
 * function, which was never a registered listener. So every unsubscribe this
 * bridge returned was a no-op, and handlers accumulated on each re-subscribe for
 * the lifetime of the window: a React effect that resubscribed on every render
 * of a dependency left one live listener behind per render, each still firing.
 *
 * Nine of those were type errors as well, because a `(data: T) => void` is not
 * an `(event, ...args) => void`. Three were not — `onChatStart`, `onChatEnd` and
 * `onAuthSignedOut` take no payload, so passing the raw callback to BOTH `on`
 * and `removeListener` type-checked and worked. They go through here too, so the
 * bridge has one shape rather than two and the next zero-argument channel cannot
 * be written the broken way by copying its neighbour.
 */
function subscribe<TPayload>(channel: string, callback: (payload: TPayload) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: TPayload): void => {
    callback(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// Custom APIs for renderer
const api = {
  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  fullscreen: () => ipcRenderer.invoke('window:fullscreen'),
  close: () => ipcRenderer.invoke('window:close'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('window:toggle-always-on-top'),
  zoomIn: () => ipcRenderer.invoke('window:zoom-in'),
  zoomOut: () => ipcRenderer.invoke('window:zoom-out'),
  zoomReset: () => ipcRenderer.invoke('window:zoom-reset'),

  // Chat
  sendMessage: (message: string, mode: string, model: string | undefined, context?: ContextItem[]) =>
    ipcRenderer.invoke('chat:send', message, mode, model, context),
  stopGeneration: () => ipcRenderer.invoke('chat:stop'),
  clearChat: () => ipcRenderer.invoke('chat:clear'),

  // User & Models
  getUserInfo: () => ipcRenderer.invoke('user:get'),
  getModels: () => ipcRenderer.invoke('models:get'),

  // Screen
  captureScreen: () => ipcRenderer.invoke('screen:capture'),

  // File selection
  selectFiles: () => ipcRenderer.invoke('file:select'),
  selectFolder: () => ipcRenderer.invoke('folder:select'),

  // Authentication
  signIn: () => ipcRenderer.invoke('auth:signIn'),
  signOut: () => ipcRenderer.invoke('auth:signOut'),
  getAuthState: () => ipcRenderer.invoke('auth:getState'),

  // Help
  showAbout: () => ipcRenderer.invoke('help:about'),

  // Event listeners
  onChatStart: (callback: () => void) => subscribe<void>('chat:start', callback),
  onChatStream: (callback: (data: { content: string }) => void) => subscribe('chat:stream', callback),
  onChatThinking: (callback: (data: { content: string }) => void) => subscribe('chat:thinking', callback),
  onChatEnd: (callback: () => void) => subscribe<void>('chat:end', callback),
  onChatError: (callback: (data: { message: string }) => void) => subscribe('chat:error', callback),
  onChatTool: (callback: (data: { tool: string; args: Record<string, unknown>; status: string }) => void) =>
    subscribe('chat:tool', callback),
  onChatToolResult: (callback: (data: { tool: string; success: boolean; result: string }) => void) =>
    subscribe('chat:toolResult', callback),
  onModeChanged: (callback: (data: { mode: string }) => void) => subscribe('chat:modeChanged', callback),
  onFullScreenChanged: (callback: (isFullScreen: boolean) => void) =>
    subscribe('window:fullscreen-changed', callback),
  onAuthSuccess: (callback: (data: { token: string; userInfo: unknown }) => void) =>
    subscribe('auth:success', callback),
  onAuthError: (callback: (data: { message: string }) => void) => subscribe('auth:error', callback),
  onAuthSignedOut: (callback: () => void) => subscribe<void>('auth:signedOut', callback)
}

type BridgeCallback = (...args: unknown[]) => void
type IpcListener = (event: IpcRendererEvent, ...args: unknown[]) => void

/**
 * The wrapper actually registered for each `(channel, callback)` pair.
 *
 * The bridge below had the SAME identity bug as the subscribers above, and this
 * one the compiler could not see: `off` takes the renderer's own
 * `(...args: unknown[]) => void`, which IS assignable to the listener type
 * `removeListener` accepts, so `tsc` was happy while the call removed nothing.
 * It was found by fixing the nine it did flag, not by the typecheck — so the
 * only thing that can keep it fixed is the test.
 *
 * A LIST per pair rather than one wrapper, because `on` may legitimately be
 * called twice with the same callback and Node's `removeListener` removes
 * exactly one instance, the most recently added. Popping matches that; storing a
 * single wrapper would orphan the earlier registration.
 */
const bridgeListeners = new Map<string, Map<BridgeCallback, IpcListener[]>>()

// Generic electron IPC bridge for dynamic channels (e.g., browser events)
const electron = {
  on: (channel: string, callback: BridgeCallback) => {
    const listener: IpcListener = (_event, ...args) => {
      callback(...args)
    }
    let byCallback = bridgeListeners.get(channel)
    if (byCallback === undefined) {
      byCallback = new Map()
      bridgeListeners.set(channel, byCallback)
    }
    byCallback.set(callback, [...(byCallback.get(callback) ?? []), listener])
    ipcRenderer.on(channel, listener)
  },
  off: (channel: string, callback: BridgeCallback) => {
    const byCallback = bridgeListeners.get(channel)
    if (byCallback === undefined) return
    const listeners = byCallback.get(callback)
    if (listeners === undefined) return
    const listener = listeners.pop()
    if (listener === undefined) return

    ipcRenderer.removeListener(channel, listener)
    // Drop the bookkeeping with the last listener it describes, so a long-lived
    // window does not accumulate empty maps for every channel it ever used.
    if (listeners.length === 0) byCallback.delete(callback)
    if (byCallback.size === 0) bridgeListeners.delete(channel)
  }
}

// Expose APIs to renderer
contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('electron', electron)
