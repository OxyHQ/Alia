/**
 * Tool Executors
 * Executes tools locally in the Electron environment
 */

import { exec } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { promisify } from 'util'
import { clipboard, shell, desktopCapturer, BrowserWindow } from 'electron'
import { Stagehand } from '@browserbasehq/stagehand'
import Store from 'electron-store'
import { errorMessage, errorCode } from './errors'
import { createLogger } from './logger'
import { PREFERRED_BROWSER_MODEL_ID } from './config'
import { currentAccessToken } from './auth'

const execAsync = promisify(exec)
const store = new Store()
const logger = createLogger('ToolExecutor')

export class ToolExecutor {
  private homeDir: string
  private allowedRoots: Set<string> = new Set()
  private openedApplications: Set<string> = new Set()
  private mainWindow?: BrowserWindow
  private stagehand?: Stagehand

  constructor(mainWindow?: BrowserWindow) {
    this.homeDir = os.homedir()
    this.mainWindow = mainWindow
  }

  /** Explicit user selection is the only operation that widens filesystem scope. */
  grantRoot(root: string): void {
    const resolved = fs.realpathSync(root)
    const directory = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved)
    this.allowedRoots.add(directory)
  }

  private isWithinAllowedRoot(candidate: string): boolean {
    for (const root of this.allowedRoots) {
      const relativePath = path.relative(root, candidate)
      if (relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))) {
        return true
      }
    }
    return false
  }

  private resolvePath(filePath?: string): string {
    const firstRoot = this.allowedRoots.values().next().value as string | undefined
    if (!firstRoot) throw new Error('Select a file or folder before using local filesystem tools')
    const requested = !filePath || filePath === '.'
      ? firstRoot
      : filePath.startsWith('~')
        ? path.join(this.homeDir, filePath.slice(1))
        : path.isAbsolute(filePath) ? filePath : path.resolve(firstRoot, filePath)
    const absolute = path.resolve(requested)
    let existing = absolute
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing)
    const realExisting = fs.realpathSync(existing)
    const canonical = path.join(realExisting, path.relative(existing, absolute))
    if (!this.isWithinAllowedRoot(canonical)) throw new Error('Path is outside the folders selected for this Cowork session')
    return canonical
  }

  async readFile(args: { path: string; start_line?: number; end_line?: number }): Promise<string> {
    if (!args.path) {
      throw new Error('File path is required for read_file')
    }
    const filePath = this.resolvePath(args.path)

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${args.path}`)
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    if (args.start_line || args.end_line) {
      const start = (args.start_line || 1) - 1
      const end = args.end_line || lines.length
      const selectedLines = lines.slice(start, end)
      return selectedLines.map((line, i) => `${start + i + 1}: ${line}`).join('\n')
    }

    return lines.map((line, i) => `${i + 1}: ${line}`).join('\n')
  }

  async writeFile(args: { path: string; content: string }): Promise<string> {
    if (!args.path) {
      throw new Error('File path is required for write_file')
    }
    const filePath = this.resolvePath(args.path)
    const dir = path.dirname(filePath)

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(filePath, args.content, 'utf-8')
    return `Successfully wrote to ${args.path}`
  }

  async editFile(args: { path: string; old_text: string; new_text: string }): Promise<string> {
    if (!args.path) {
      throw new Error('File path is required for edit_file')
    }
    const filePath = this.resolvePath(args.path)

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${args.path}`)
    }

    const content = fs.readFileSync(filePath, 'utf-8')

    if (!content.includes(args.old_text)) {
      throw new Error(`Could not find the specified text in ${args.path}`)
    }

    const newContent = content.replace(args.old_text, args.new_text)
    fs.writeFileSync(filePath, newContent, 'utf-8')

    return `Successfully edited ${args.path}`
  }

  async listFiles(args: { path?: string; recursive?: boolean }): Promise<string> {
    const dirPath = this.resolvePath(args.path)

    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory not found: ${args.path}`)
    }

    const listDir = (dir: string, prefix = ''): string[] => {
      const items: string[] = []
      const entries = fs.readdirSync(dir, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue

        const fullPath = path.join(dir, entry.name)
        const displayPath = prefix + entry.name

        if (entry.isDirectory()) {
          items.push(`${displayPath}/`)
          if (args.recursive) {
            items.push(...listDir(fullPath, `${displayPath}/`))
          }
        } else {
          items.push(displayPath)
        }
      }
      return items
    }

    const files = listDir(dirPath)
    return files.join('\n')
  }

  async searchFiles(args: { pattern: string; path?: string }): Promise<string> {
    if (!args.pattern) {
      throw new Error('Search pattern is required for search_files')
    }
    const searchPath = this.resolvePath(args.path)
    const platform = process.platform

    let command: string
    if (platform === 'win32') {
      command = `findstr /s /n /i "${args.pattern}" *.*`
    } else {
      command = `grep -rn "${args.pattern}" .`
    }

    try {
      const { stdout } = await execAsync(command, { cwd: searchPath, maxBuffer: 1024 * 1024 })
      return stdout.slice(0, 5000)
    } catch (error: unknown) {
      if (errorCode(error) === 1) {
        return 'No matches found'
      }
      throw error
    }
  }

  async runCommand(args: { command: string; cwd?: string }): Promise<string> {
    if (!args.command) {
      throw new Error('Command is required for run_command')
    }
    const cwd = this.resolvePath(args.cwd)

    const { stdout, stderr } = await execAsync(args.command, {
      cwd,
      maxBuffer: 1024 * 1024,
      timeout: 60000
    })
    const output = stdout + (stderr ? `\n${stderr}` : '')
    return output.slice(0, 10000)
  }

  async openApplication(args: { application_name: string }): Promise<string> {
    if (!args.application_name) {
      throw new Error('Application name is required for open_application')
    }
    // Check if already opened in this session
    if (this.openedApplications.has(args.application_name)) {
      return `${args.application_name} is already open. DO NOT call open_application again for this application. Task is complete.`
    }

    await shell.openPath(args.application_name)
    this.openedApplications.add(args.application_name)
    return `Successfully opened ${args.application_name}. Application is now running. DO NOT call open_application again for this application.`
  }

  async openUrl(args: { url: string }): Promise<string> {
    if (!args.url) {
      throw new Error('URL is required for open_url')
    }
    await shell.openExternal(args.url)
    return `Opened ${args.url}`
  }

  clipboardRead(): string {
    const text = clipboard.readText()
    return text || '(clipboard is empty)'
  }

  clipboardWrite(args: { text: string }): string {
    if (!args.text && args.text !== '') {
      throw new Error('Text is required for clipboard_write')
    }
    clipboard.writeText(args.text)
    return 'Copied to clipboard'
  }

  getSystemInfo(): string {
    const info = {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
      freeMemory: `${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`,
      filesystemScope: this.allowedRoots.size > 0 ? 'user-selected roots' : 'none',
      tempDir: os.tmpdir(),
      uptime: `${Math.round(os.uptime() / 3600)} hours`
    }
    return JSON.stringify(info, null, 2)
  }

  async screenshot(args?: { path?: string }): Promise<string> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })

      if (sources.length === 0) {
        throw new Error('No screen found. Please check screen recording permissions.')
      }

      const dataURL = sources[0].thumbnail.toDataURL()

      // If path is provided, save to file
      if (args?.path) {
        const filePath = this.resolvePath(args.path)
        const dir = path.dirname(filePath)

        // Create directory if it doesn't exist
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        // Extract base64 data from data URL
        const base64Data = dataURL.replace(/^data:image\/\w+;base64,/, '')
        const buffer = Buffer.from(base64Data, 'base64')

        // Save to file
        fs.writeFileSync(filePath, buffer)
        return `Screenshot saved to ${args.path}`
      }

      // Return data URL if no path specified
      return dataURL
    } catch (error: unknown) {
      const msg = errorMessage(error)
      if (msg.includes('not allowed') || msg.includes('permission')) {
        if (process.platform === 'darwin') {
          throw new Error('Screen recording permission denied. Please enable screen recording for Alia Cowork in System Preferences → Security & Privacy → Screen Recording, then restart the app.')
        } else if (process.platform === 'win32') {
          throw new Error('Screen recording permission denied. Please check Windows privacy settings for screen capture permissions.')
        } else {
          throw new Error('Screen recording permission denied. Please check your system permissions.')
        }
      }
      throw error
    }
  }

  async listInstalledApplications(): Promise<string> {
    try {
      const platform = process.platform
      let apps: string[] = []

      if (platform === 'win32') {
        // Windows: Use PowerShell to list installed apps from Start Menu
        const startMenuPaths = [
          `${process.env.APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs`,
          `${process.env.ProgramData}\\Microsoft\\Windows\\Start Menu\\Programs`
        ]

        for (const menuPath of startMenuPaths) {
          if (fs.existsSync(menuPath)) {
            const findShortcuts = (dir: string): string[] => {
              const items: string[] = []
              try {
                const entries = fs.readdirSync(dir, { withFileTypes: true })
                for (const entry of entries) {
                  const fullPath = path.join(dir, entry.name)
                  if (entry.isDirectory()) {
                    items.push(...findShortcuts(fullPath))
                  } else if (entry.name.endsWith('.lnk') || entry.name.endsWith('.exe')) {
                    items.push(entry.name.replace(/\.lnk$/, '').replace(/\.exe$/, ''))
                  }
                }
              } catch (e) {
                // Skip directories we can't read
              }
              return items
            }
            apps.push(...findShortcuts(menuPath))
          }
        }

        // Also add common app executables
        apps.push('wt.exe', 'cmd.exe', 'powershell.exe', 'notepad.exe', 'explorer.exe')
      } else if (platform === 'darwin') {
        // macOS: List apps from /Applications
        const appDirs = ['/Applications', path.join(os.homedir(), 'Applications')]
        for (const appDir of appDirs) {
          if (fs.existsSync(appDir)) {
            const entries = fs.readdirSync(appDir, { withFileTypes: true })
            for (const entry of entries) {
              if (entry.name.endsWith('.app')) {
                apps.push(entry.name.replace(/\.app$/, ''))
              }
            }
          }
        }
      } else {
        // Linux: List .desktop files
        const desktopDirs = [
          '/usr/share/applications',
          '/usr/local/share/applications',
          path.join(os.homedir(), '.local/share/applications')
        ]
        for (const desktopDir of desktopDirs) {
          if (fs.existsSync(desktopDir)) {
            const entries = fs.readdirSync(desktopDir)
            for (const entry of entries) {
              if (entry.endsWith('.desktop')) {
                apps.push(entry.replace(/\.desktop$/, ''))
              }
            }
          }
        }
      }

      // Remove duplicates and sort
      const uniqueApps = [...new Set(apps)].sort()

      if (uniqueApps.length === 0) {
        return 'No applications found. Try using the full path or executable name.'
      }

      return `Found ${uniqueApps.length} installed applications:\n\n${uniqueApps.join('\n')}`
    } catch (error: unknown) {
      return `Error listing applications: ${errorMessage(error)}`
    }
  }


  /**
   * Browser automation using Stagehand Agent
   * Opens a browser, performs actions, and shows preview
   */
  async browserAction(args: Record<string, unknown>): Promise<string> {
    try {
      // Normalize args - handle multiple possible parameter names that AI might use
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
      const normalizedArgs = {
        url: str(args.url),
        action: str(args.action) || str(args.instruction) || str(args.user_instruction) || str(args.task) || str(args.query),
        extract: str(args.extract)
      }

      logger.debug('Browser action called with:', JSON.stringify(args, null, 2))
      logger.debug('Normalized args:', JSON.stringify(normalizedArgs, null, 2))

      // Initialize Stagehand if not already initialized
      if (!this.stagehand) {
        logger.debug('Initializing Stagehand in headless mode...')
        this.stagehand = new Stagehand({
          env: 'LOCAL',
          verbose: 1,
          experimental: true, // Required for agent callbacks
          localBrowserLaunchOptions: {
            headless: true, // Run browser invisibly - no visible window
          }
        })
        await this.stagehand.init()
        logger.debug('Stagehand initialized in headless mode - browser runs invisibly, screenshots sent to app')
      }

      // Get the first page
      const pages = this.stagehand.context.pages()
      if (pages.length === 0) {
        throw new Error('No browser pages available')
      }
      const page = pages[0]

      // Send initial browser opened event
      if (this.mainWindow) {
        this.mainWindow.webContents.send('browser:opened', {})
      }

      // Helper to capture and send screenshot
      const capturePreview = async () => {
        try {
          const screenshot = await page.screenshot({ type: 'png', fullPage: false })
          const base64 = screenshot.toString('base64')
          if (this.mainWindow) {
            this.mainWindow.webContents.send('browser:preview', {
              screenshot: `data:image/png;base64,${base64}`
            })
          }
        } catch (error) {
          logger.error('Error capturing screenshot:', error)
        }
      }

      let result = ''
      let instruction = ''

      // Build instruction for agent
      if (normalizedArgs.url && normalizedArgs.action) {
        instruction = `Go to ${normalizedArgs.url}, then ${normalizedArgs.action}`
      } else if (normalizedArgs.url) {
        instruction = `Navigate to ${normalizedArgs.url}`
      } else if (normalizedArgs.action) {
        instruction = normalizedArgs.action
      }

      // If we have an instruction, use the agent for intelligent multi-step execution
      if (instruction) {
        logger.debug(`Using agent with instruction: ${instruction}`)

        // Navigate to URL first if provided
        if (normalizedArgs.url) {
          logger.debug(`Navigating to ${normalizedArgs.url}`)
          await page.goto(normalizedArgs.url)
          await page.waitForLoadState('networkidle')
          await capturePreview()
        }

        // Use agent for the action if we have one
        if (normalizedArgs.action) {
          logger.debug(`Creating agent for action: ${normalizedArgs.action}`)

          // Get Alia API credentials
          const apiKey = currentAccessToken() ?? ''
          const baseUrl = store.get('apiBaseUrl') as string

          /**
           * The one `/v1` chat caller left in this process, and a legitimate
           * one: Stagehand is a third-party OpenAI-protocol library that derives
           * `POST {baseURL}/chat/completions` itself, so the protocol names the
           * path. `/v1/chat/completions` and `/alia/chat` are one handler
           * (`packages/api/src/routes/chat.ts`) and both are Alia's permanent
           * product API (ADR 0010), so nothing is lost by staying here — except
           * the named product events, which a browser agent has no use for.
           * Cowork's own chat moved to `/alia/chat` in `./chat.ts` because it
           * DOES read them.
           *
           * The bearer is the Oxy session token. The model is `route:research`
           * (`./config`), a canonical routing profile the boundary accepts; the
           * `profile:*` spelling it used to send was refused on every call.
           */
          const agent = this.stagehand.agent({
            model: {
              modelName: PREFERRED_BROWSER_MODEL_ID,
              apiKey: apiKey,
              baseURL: `${baseUrl}/v1`, // Alia API endpoint (OpenAI-compatible)
            }
          })

          // Execute with callbacks to capture screenshots during execution
          const agentResult = await agent.execute({
            instruction: normalizedArgs.action,
            maxSteps: 10,
            callbacks: {
              onStepFinish: async (event: { finishReason?: string }) => {
                logger.debug(`Agent step finished: ${event.finishReason}`)
                await capturePreview()
              }
            }
          })

          logger.debug('Agent result:', JSON.stringify(agentResult, null, 2))
          result += agentResult.message || 'Action completed'
        } else {
          result = `Navigated to ${normalizedArgs.url}`
        }
      }

      // Extract data if requested
      if (normalizedArgs.extract) {
        logger.debug(`Extracting: ${normalizedArgs.extract}`)
        const extracted = await this.stagehand.extract(normalizedArgs.extract)
        await capturePreview()
        result += `\n\nExtracted data: ${JSON.stringify(extracted, null, 2)}`
      }

      // Final screenshot
      await capturePreview()

      return result || 'Browser action completed successfully'
    } catch (error: unknown) {
      logger.error('Browser action failed:', error)
      const msg = errorMessage(error)

      // Send error to frontend
      if (this.mainWindow) {
        this.mainWindow.webContents.send('browser:error', {
          error: msg
        })
      }

      throw new Error(`Browser automation failed: ${msg}`)
    }
  }

  /**
   * Close browser if open
   */
  async closeBrowser(): Promise<string> {
    try {
      if (this.stagehand) {
        await this.stagehand.close()
        this.stagehand = undefined

        if (this.mainWindow) {
          this.mainWindow.webContents.send('browser:closed', {})
        }

        return 'Browser closed'
      }
      return 'Browser was not open'
    } catch (error: unknown) {
      throw new Error(`Failed to close browser: ${errorMessage(error)}`)
    }
  }

  /**
   * Reset session state (called when conversation is cleared)
   */
  async reset(): Promise<void> {
    this.openedApplications.clear()

    // Close browser if open
    if (this.stagehand) {
      try {
        await this.stagehand.close()
        this.stagehand = undefined
      } catch (error) {
        logger.error('Error closing browser during reset:', error)
      }
    }
  }
}
