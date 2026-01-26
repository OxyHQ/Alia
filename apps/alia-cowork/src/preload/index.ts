import { contextBridge, ipcRenderer } from 'electron'

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
  sendMessage: (message: string, mode: string, model: string, context?: any[]) =>
    ipcRenderer.invoke('chat:send', message, mode, model, context),
  stopGeneration: () => ipcRenderer.invoke('chat:stop'),
  clearChat: () => ipcRenderer.invoke('chat:clear'),

  // User & Models
  getUserInfo: () => ipcRenderer.invoke('user:get'),
  getModels: () => ipcRenderer.invoke('models:get'),

  // Screen
  captureScreen: () => ipcRenderer.invoke('screen:capture'),

  // Authentication
  signIn: () => ipcRenderer.invoke('auth:signIn'),
  signOut: () => ipcRenderer.invoke('auth:signOut'),
  getAuthState: () => ipcRenderer.invoke('auth:getState'),

  // Help
  showAbout: () => ipcRenderer.invoke('help:about'),

  // Event listeners
  onChatStart: (callback: () => void) => {
    ipcRenderer.on('chat:start', callback)
    return () => ipcRenderer.removeListener('chat:start', callback)
  },
  onChatStream: (callback: (data: { content: string }) => void) => {
    ipcRenderer.on('chat:stream', (_, data) => callback(data))
    return () => ipcRenderer.removeListener('chat:stream', callback)
  },
  onChatThinking: (callback: (data: { content: string }) => void) => {
    ipcRenderer.on('chat:thinking', (_, data) => callback(data))
    return () => ipcRenderer.removeListener('chat:thinking', callback)
  },
  onChatEnd: (callback: () => void) => {
    ipcRenderer.on('chat:end', callback)
    return () => ipcRenderer.removeListener('chat:end', callback)
  },
  onChatError: (callback: (data: { message: string }) => void) => {
    ipcRenderer.on('chat:error', (_, data) => callback(data))
    return () => ipcRenderer.removeListener('chat:error', callback)
  },
  onChatTool: (callback: (data: { tool: string; args: any; status: string }) => void) => {
    ipcRenderer.on('chat:tool', (_, data) => callback(data))
    return () => ipcRenderer.removeListener('chat:tool', callback)
  },
  onChatToolResult: (callback: (data: { tool: string; success: boolean; result: string }) => void) => {
    ipcRenderer.on('chat:toolResult', (_, data) => callback(data))
    return () => ipcRenderer.removeListener('chat:toolResult', callback)
  },
  onModeChanged: (callback: (data: { mode: string }) => void) => {
    ipcRenderer.on('chat:modeChanged', (_, data) => callback(data))
    return () => ipcRenderer.removeListener('chat:modeChanged', callback)
  },
  onFullScreenChanged: (callback: (isFullScreen: boolean) => void) => {
    ipcRenderer.on('window:fullscreen-changed', (_, isFullScreen) => callback(isFullScreen))
    return () => ipcRenderer.removeListener('window:fullscreen-changed', callback)
  },
  onAuthSuccess: (callback: (data: { token: string; userInfo: any }) => void) => {
    ipcRenderer.on('auth:success', (_, data) => callback(data))
    return () => ipcRenderer.removeListener('auth:success', callback)
  },
  onAuthError: (callback: (data: { message: string }) => void) => {
    ipcRenderer.on('auth:error', (_, data) => callback(data))
    return () => ipcRenderer.removeListener('auth:error', callback)
  },
  onAuthSignedOut: (callback: () => void) => {
    ipcRenderer.on('auth:signedOut', callback)
    return () => ipcRenderer.removeListener('auth:signedOut', callback)
  }
}

// Expose APIs to renderer
contextBridge.exposeInMainWorld('api', api)
