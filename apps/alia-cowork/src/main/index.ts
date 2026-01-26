import { app, shell, BrowserWindow, ipcMain, screen, desktopCapturer } from 'electron'
import { join } from 'path'
import { config } from 'dotenv'
import { ToolExecutor } from './tools'
import { ChatProvider } from './chat'
import { AuthProvider } from './auth'

// Load environment variables from .env file
config({ path: join(__dirname, '../../.env') })

// Check if running in development mode
const isDev = process.env.NODE_ENV === 'development'

// State
let mainWindow: BrowserWindow | null = null
let toolExecutor: ToolExecutor
let chatProvider: ChatProvider
let authProvider: AuthProvider
let isFullScreen = false
let savedBounds: Electron.Rectangle | null = null

// Constants
const DEFAULT_WIDTH = 480
const DEFAULT_HEIGHT = 720
const MIN_WIDTH = 400
const MIN_HEIGHT = 500

function createWindow(): void {
  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize

  mainWindow = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    x: screenWidth - DEFAULT_WIDTH - 20,
    y: 20,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
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
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })
    return sources[0]?.thumbnail.toDataURL() ?? null
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
