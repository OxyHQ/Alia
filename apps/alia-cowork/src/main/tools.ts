/**
 * Tool Executors
 * Executes tools locally in the Electron environment
 */

import { exec } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { promisify } from 'util'
import { clipboard, shell, desktopCapturer } from 'electron'

const execAsync = promisify(exec)

export class ToolExecutor {
  private homeDir: string
  private openedApplications: Set<string> = new Set()

  constructor() {
    this.homeDir = os.homedir()
  }

  private resolvePath(filePath?: string): string {
    // Default to home directory if no path provided
    if (!filePath || filePath === '' || filePath === '.') {
      return this.homeDir
    }
    if (path.isAbsolute(filePath)) {
      return filePath
    }
    if (filePath.startsWith('~')) {
      return path.join(this.homeDir, filePath.slice(1))
    }
    return path.resolve(filePath)
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
    const dirPath = this.resolvePath(args.path || this.homeDir)

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
    const searchPath = this.resolvePath(args.path || this.homeDir)
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
    } catch (error: any) {
      if (error.code === 1) {
        return 'No matches found'
      }
      throw error
    }
  }

  async runCommand(args: { command: string; cwd?: string }): Promise<string> {
    if (!args.command) {
      throw new Error('Command is required for run_command')
    }
    const cwd = args.cwd ? this.resolvePath(args.cwd) : this.homeDir

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
      homeDir: os.homedir(),
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
    } catch (error: any) {
      if (error.message?.includes('not allowed') || error.message?.includes('permission')) {
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
    } catch (error: any) {
      return `Error listing applications: ${error.message}`
    }
  }

  /**
   * Reset session state (called when conversation is cleared)
   */
  reset(): void {
    this.openedApplications.clear()
  }
}
