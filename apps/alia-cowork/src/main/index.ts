import { app, shell, BrowserWindow, ipcMain, screen, desktopCapturer, dialog, systemPreferences } from 'electron'
import { join } from 'path'
import { config } from 'dotenv'
import { ToolExecutor } from './tools'
import { ChatProvider } from './chat'
import { AuthProvider } from './auth'
import { WindowStateManager } from './windowState'

// Load environment variables from .env file
config({ path: join(__dirname, '../../.env') })

// Check if running in development mode
const isDev = process.env.NODE_ENV === 'development'

// State
let mainWindow: BrowserWindow | null = null
let toolExecutor: ToolExecutor
let chatProvider: ChatProvider
let authProvider: AuthProvider
let windowStateManager: WindowStateManager
let isFullScreen = false
let savedBounds: Electron.Rectangle | null = null

// Constants
const DEFAULT_WIDTH = 480
const DEFAULT_HEIGHT = 720
const MIN_WIDTH = 400
const MIN_HEIGHT = 500

function createWindow(): void {
  // Initialize window state manager
  windowStateManager = new WindowStateManager()
  const initialBounds = windowStateManager.getInitialBounds()

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    transparent: false,
    alwaysOnTop: false,
    resizable: true,
    maximizable: true,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#1a1a2e',
    // macOS specific
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hiddenInset' as const,
      vibrancy: 'under-window' as const
    })
  })

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    // Start tracking window state
    if (mainWindow) {
      windowStateManager.track(mainWindow)
    }
    // Check screen recording permission on macOS (async, non-blocking)
    if (process.platform === 'darwin') {
      checkScreenRecordingPermission().catch(console.error)
    }
  })

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Load the app
  mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

  // Initialize services
  toolExecutor = new ToolExecutor()
  chatProvider = new ChatProvider(mainWindow, toolExecutor)
  authProvider = new AuthProvider(mainWindow)

  // Register keyboard shortcuts
  mainWindow.webContents.on('before-input-event', handleKeyboardShortcuts)
}

function handleKeyboardShortcuts(event: Electron.Event, input: Electron.Input): void {
  if (!mainWindow) return

  // Zoom shortcuts (Ctrl/Cmd + Plus/Minus/Zero)
  if (input.control || input.meta) {
    const zoom = mainWindow.webContents.getZoomFactor()
    if (input.key === '=' || input.key === '+') {
      event.preventDefault()
      mainWindow.webContents.setZoomFactor(Math.min(zoom + 0.1, 2.0))
    } else if (input.key === '-') {
      event.preventDefault()
      mainWindow.webContents.setZoomFactor(Math.max(zoom - 0.1, 0.5))
    } else if (input.key === '0') {
      event.preventDefault()
      mainWindow.webContents.setZoomFactor(1.0)
    }
  }

  // F11 for fullscreen toggle
  if (input.key === 'F11') {
    event.preventDefault()
    toggleFullScreen()
  }
}

function toggleFullScreen(): boolean {
  if (!mainWindow) return false

  if (isFullScreen) {
    // Exit fullscreen - restore saved bounds
    if (savedBounds) {
      mainWindow.setBounds(savedBounds)
    }
    mainWindow.setAlwaysOnTop(true)
    isFullScreen = false
  } else {
    // Enter fullscreen - save current bounds and maximize to full display
    savedBounds = mainWindow.getBounds()
    mainWindow.setAlwaysOnTop(false)
    const { bounds } = screen.getPrimaryDisplay()
    mainWindow.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
    isFullScreen = true
  }

  mainWindow.webContents.send('window:fullscreen-changed', isFullScreen)
  return isFullScreen
}

async function checkScreenRecordingPermission(): Promise<boolean> {
  // Only check on macOS
  if (process.platform !== 'darwin') {
    return true
  }

  try {
    // Try to get screen sources to trigger permission prompt
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 }
    })
    return sources.length > 0
  } catch (error) {
    console.error('Screen recording permission check failed:', error)
    return false
  }
}

async function requestScreenRecordingPermission(): Promise<void> {
  if (process.platform !== 'darwin') return

  const hasPermission = await checkScreenRecordingPermission()

  if (!hasPermission && mainWindow) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Screen Recording Permission Required',
      message: 'Alia Cowork needs screen recording permission to capture screenshots.',
      detail: 'Please enable Screen Recording for Alia Cowork in System Preferences → Security & Privacy → Screen Recording, then restart the app.',
      buttons: ['Open System Preferences', 'Cancel']
    })

    if (result.response === 0) {
      // Open System Preferences to Screen Recording settings
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    }
  }
}

function setupIPC(): void {
  // Window controls
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())

  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
      return false
    }
    mainWindow.maximize()
    return true
  })

  ipcMain.handle('window:fullscreen', () => toggleFullScreen())

  ipcMain.handle('window:close', () => mainWindow?.close())

  ipcMain.handle('window:toggle-always-on-top', () => {
    if (!mainWindow) return false
    const newState = !mainWindow.isAlwaysOnTop()
    mainWindow.setAlwaysOnTop(newState)
    return newState
  })

  // Zoom controls
  ipcMain.handle('window:zoom-in', () => {
    if (!mainWindow) return 1.0
    const zoom = Math.min(mainWindow.webContents.getZoomFactor() + 0.1, 2.0)
    mainWindow.webContents.setZoomFactor(zoom)
    return zoom
  })

  ipcMain.handle('window:zoom-out', () => {
    if (!mainWindow) return 1.0
    const zoom = Math.max(mainWindow.webContents.getZoomFactor() - 0.1, 0.5)
    mainWindow.webContents.setZoomFactor(zoom)
    return zoom
  })

  ipcMain.handle('window:zoom-reset', () => {
    mainWindow?.webContents.setZoomFactor(1.0)
    return 1.0
  })

  // Chat
  ipcMain.handle('chat:send', async (_, message, mode, model, context) => {
    return chatProvider.handleMessage(message, mode, model, context)
  })

  ipcMain.handle('chat:stop', () => chatProvider.stop())

  ipcMain.handle('chat:clear', () => chatProvider.clear())

  // User & Models
  ipcMain.handle('user:get', () => chatProvider.getUserInfo())

  ipcMain.handle('models:get', () => chatProvider.getModels())

  // Screen capture
  ipcMain.handle('screen:capture', async () => {
    try {
      // Check permission first on macOS
      if (process.platform === 'darwin') {
        const hasPermission = await checkScreenRecordingPermission()
        if (!hasPermission) {
          await requestScreenRecordingPermission()
          throw new Error('Screen recording permission denied. Please enable it in System Preferences.')
        }
      }

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })

      if (sources.length === 0) {
        throw new Error('No screen found')
      }

      return sources[0].thumbnail.toDataURL()
    } catch (error: any) {
      console.error('Screen capture failed:', error)
      throw error
    }
  })

  // Permission check handler
  ipcMain.handle('permissions:check-screen-recording', async () => {
    return await checkScreenRecordingPermission()
  })

  ipcMain.handle('permissions:request-screen-recording', async () => {
    await requestScreenRecordingPermission()
  })

  // Tool execution
  ipcMain.handle('tool:execute', async (_, toolName, args) => {
    return toolExecutor.execute(toolName, args)
  })

  // Authentication
  ipcMain.handle('auth:signIn', async () => {
    await authProvider.startAuth()
  })

  ipcMain.handle('auth:signOut', () => {
    authProvider.signOut()
  })

  ipcMain.handle('auth:getState', () => {
    return authProvider.getAuthState()
  })

  // Help
  ipcMain.handle('help:about', async () => {
    if (!mainWindow) return

    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'About Alia Cowork',
      message: 'Alia Cowork',
      detail: 'Version 1.0.0\n\nAI-powered desktop assistant for Windows and macOS.\n\nMade with ❤️ in the 🌎 by Oxy.',
      buttons: ['OK']
    })
  })
}

// App lifecycle
app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.alia.cowork')
  }

  setupIPC()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (windowStateManager) {
    windowStateManager.untrack()
  }
})
