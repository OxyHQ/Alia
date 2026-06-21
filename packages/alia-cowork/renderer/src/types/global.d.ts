// Global type declarations for the renderer process

declare global {
  interface Window {
    api: {
      // Window controls
      minimize: () => void
      maximize: () => Promise<boolean>
      fullscreen: () => Promise<boolean>
      close: () => void
      toggleAlwaysOnTop: () => Promise<boolean>
      zoomIn: () => Promise<number>
      zoomOut: () => Promise<number>
      zoomReset: () => Promise<number>
      onFullScreenChanged: (callback: (isFullScreen: boolean) => void) => () => void

      // Chat
      sendMessage: (message: string, mode: string, model: string, context?: any[]) => Promise<void>
      stopGeneration: () => void
      clearChat: () => void
      getModels: () => Promise<any[]>
      captureScreen: () => Promise<string | null>
      selectFiles: () => Promise<any[] | null>
      selectFolder: () => Promise<any[] | null>
      onChatStart: (callback: () => void) => () => void
      onChatStream: (callback: (data: { content: string }) => void) => () => void
      onChatThinking: (callback: (data: { content: string }) => void) => () => void
      onChatEnd: (callback: () => void) => () => void
      onChatError: (callback: (data: { message: string }) => void) => () => void
      onChatTool: (callback: (data: { tool: string; args: any; status: string }) => void) => () => void
      onChatToolResult: (callback: (data: { tool: string; success: boolean; result: string }) => void) => () => void
      onModeChanged: (callback: (data: { mode: string }) => void) => () => void

      // Auth
      signIn: () => Promise<void>
      signOut: () => void
      getAuthState: () => Promise<{ isAuthenticated: boolean; apiKey?: string }>
      getUserInfo: () => Promise<any>
      onAuthSuccess: (callback: (data: { token: string; userInfo: any }) => void) => () => void
      onAuthError: (callback: (data: { message: string }) => void) => () => void
      onAuthSignedOut: (callback: () => void) => () => void

      // Help
      showAbout: () => Promise<void>
    }

    electron: {
      // IPC event listeners
      on: (channel: string, callback: (...args: unknown[]) => void) => void
      off: (channel: string, callback: (...args: unknown[]) => void) => void
    }
  }
}

export {}
