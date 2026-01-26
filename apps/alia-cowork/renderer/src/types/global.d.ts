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
      clearChat?: () => void

      // Auth
      signIn: () => Promise<void>
      signOut: () => void
      getAuthState: () => Promise<{ isAuthenticated: boolean; apiKey?: string }>
      getUserInfo: () => Promise<any>
      onAuthSuccess: (callback: (data: { token: string; userInfo: any }) => void) => () => void
      onAuthError: (callback: (data: { message: string }) => void) => () => void
      onAuthSignedOut: (callback: () => void) => () => void
    }
  }
}

export {}
