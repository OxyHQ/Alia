import Store from 'electron-store'
import { BrowserWindow, screen } from 'electron'

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

// Initial size for first launch (centered, larger)
const INITIAL_WIDTH = 800
const INITIAL_HEIGHT = 900
const MIN_WIDTH = 400
const MIN_HEIGHT = 500

// Create dedicated store for window state
const store = new Store<{ bounds: WindowBounds }>({
  name: 'window',
  defaults: {
    bounds: {
      x: 0,
      y: 0,
      width: INITIAL_WIDTH,
      height: INITIAL_HEIGHT,
      isMaximized: false
    }
  }
})

export class WindowStateManager {
  private window: BrowserWindow | null = null
  private saveTimeout: NodeJS.Timeout | null = null
  private isQuitting = false

  /**
   * Get saved bounds or calculate default position
   */
  getInitialBounds(): Partial<Electron.BrowserWindowConstructorOptions> {
    const savedBounds = store.get('bounds')

    // Validate saved bounds
    if (this.isValidBounds(savedBounds)) {
      return {
        x: savedBounds.x,
        y: savedBounds.y,
        width: savedBounds.width,
        height: savedBounds.height
      }
    }

    // Fallback to default position (centered on screen)
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
    return {
      x: Math.round((screenWidth - INITIAL_WIDTH) / 2),
      y: Math.round((screenHeight - INITIAL_HEIGHT) / 2),
      width: INITIAL_WIDTH,
      height: INITIAL_HEIGHT
    }
  }

  /**
   * Check if saved bounds was maximized
   */
  wasMaximized(): boolean {
    return store.get('bounds').isMaximized
  }

  /**
   * Validate bounds are visible on at least one display
   */
  private isValidBounds(bounds: WindowBounds): boolean {
    // Check bounds exist and have valid dimensions
    if (!bounds ||
        typeof bounds.x !== 'number' ||
        typeof bounds.y !== 'number' ||
        typeof bounds.width !== 'number' ||
        typeof bounds.height !== 'number') {
      return false
    }

    // Check minimum size constraints
    if (bounds.width < MIN_WIDTH || bounds.height < MIN_HEIGHT) {
      return false
    }

    // Check if window is visible on any display
    const displays = screen.getAllDisplays()
    const windowCenterX = bounds.x + bounds.width / 2
    const windowCenterY = bounds.y + bounds.height / 2

    return displays.some(display => {
      const area = display.workArea
      return (
        windowCenterX >= area.x &&
        windowCenterX < area.x + area.width &&
        windowCenterY >= area.y &&
        windowCenterY < area.y + area.height
      )
    })
  }

  /**
   * Start tracking window state
   */
  track(window: BrowserWindow): void {
    this.window = window

    // Restore maximized state
    if (this.wasMaximized()) {
      window.maximize()
    }

    // Listen to window events
    window.on('resize', () => this.debouncedSave())
    window.on('move', () => this.debouncedSave())
    window.on('maximize', () => this.saveBounds())
    window.on('unmaximize', () => this.saveBounds())
    window.on('close', () => {
      this.isQuitting = true
      this.saveBounds()
    })
  }

  /**
   * Debounced save to prevent excessive writes
   */
  private debouncedSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
    }

    this.saveTimeout = setTimeout(() => {
      this.saveBounds()
    }, 500)
  }

  /**
   * Save current window bounds
   */
  private saveBounds(): void {
    if (!this.window || this.window.isDestroyed()) {
      return
    }

    // Don't save bounds if window is in fullscreen or minimized
    if (this.window.isFullScreen() || this.window.isMinimized()) {
      return
    }

    const isMaximized = this.window.isMaximized()
    const bounds = this.window.getBounds()

    store.set('bounds', {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized
    })
  }

  /**
   * Cleanup
   */
  untrack(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
    }
    this.window = null
  }
}
