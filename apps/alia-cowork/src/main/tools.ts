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

  constructor() {
    this.homeDir = os.homedir()
  }

  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath
    }
    if (filePath.startsWith('~')) {
      return path.join(this.homeDir, filePath.slice(1))
    }
    return path.resolve(filePath)
  }

  async readFile(args: { path: string; start_line?: number; end_line?: number }): Promise<string> {
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
    const filePath = this.resolvePath(args.path)
    const dir = path.dirname(filePath)

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(filePath, args.content, 'utf-8')
    return `Successfully wrote to ${args.path}`
  }

  async editFile(args: { path: string; old_text: string; new_text: string }): Promise<string> {
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

  async listFiles(args: { path: string; recursive?: boolean }): Promise<string> {
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
    const searchPath = this.resolvePath(args.path || '.')
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
    await shell.openPath(args.application_name)
    return `Opened ${args.application_name}`
  }

  async openUrl(args: { url: string }): Promise<string> {
    await shell.openExternal(args.url)
    return `Opened ${args.url}`
  }

  clipboardRead(): string {
    const text = clipboard.readText()
    return text || '(clipboard is empty)'
  }

  clipboardWrite(args: { text: string }): string {
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
}
