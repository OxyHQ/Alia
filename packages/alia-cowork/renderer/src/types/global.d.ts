// Global type declarations for the renderer process

/** A file/folder context item attached to a chat message. */
interface ContextItem {
  type?: 'file' | 'folder'
  path: string
  name?: string
  fullPath?: string
  content?: string
  language?: string
}

/** Authenticated user profile returned by `getUserInfo`. */
interface UserProfile {
  name?: string
  username?: string
  email?: string
  [key: string]: unknown
}

/** A selected file/folder returned by the native picker. */
interface SelectedFile {
  type: 'file'
  path: string
  fullPath: string
  content: string
  language: string
}

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
      sendMessage: (message: string, mode: string, model: string | undefined, context?: ContextItem[]) => Promise<void>
      stopGeneration: () => void
      clearChat: () => void
      captureScreen: () => Promise<string | null>
      selectFiles: () => Promise<SelectedFile[] | null>
      selectFolder: () => Promise<SelectedFile[] | null>
      onChatStart: (callback: () => void) => () => void
      onChatStream: (callback: (data: { content: string }) => void) => () => void
      onChatThinking: (callback: (data: { content: string }) => void) => () => void
      onChatEnd: (callback: () => void) => () => void
      onChatError: (callback: (data: { message: string }) => void) => () => void
      onChatTool: (callback: (data: { tool: string; args: Record<string, unknown>; status: string }) => void) => () => void
      onChatToolResult: (callback: (data: { tool: string; success: boolean; result: string }) => void) => () => void
      onModeChanged: (callback: (data: { mode: string }) => void) => () => void

      // Auth
      signIn: () => Promise<void>
      signOut: () => void
      getAuthState: () => Promise<{
        isAuthenticated: boolean
        username?: string
        preferredModel: string
      }>
      getUserInfo: () => Promise<UserProfile | null>
      onAuthCode: (
        callback: (data: { code: string; url: string; expiresAt: number }) => void
      ) => () => void
      onAuthSuccess: (callback: (data: { userInfo: UserProfile }) => void) => () => void
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
