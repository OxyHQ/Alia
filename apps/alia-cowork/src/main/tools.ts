/**
 * Tool Executor - Handles local tool execution
 * No AI SDK dependencies - tools are defined in chat.ts in OpenAI format
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
    // Expand ~ to home directory
    if (filePath.startsWith('~')) {
      return path.join(this.homeDir, filePath.slice(1))
    }
    return path.resolve(filePath)
  }

  async execute(toolName: string, args: any): Promise<string> {
    try {
      switch (toolName) {
        case 'read_file':
          return await this.readFile(args)
        case 'write_file':
          return await this.writeFile(args)
        case 'edit_file':
          return await this.editFile(args)
        case 'list_files':
          return await this.listFiles(args)
        case 'search_files':
          return await this.searchFiles(args)
        case 'run_command':
          return await this.runCommand(args)
        case 'open_application':
          return await this.openApplication(args)
        case 'open_url':
          return await this.openUrl(args)
        case 'clipboard_read':
          return this.clipboardRead()
        case 'clipboard_write':
          return this.clipboardWrite(args)
        case 'get_system_info':
          return this.getSystemInfo()
        case 'screenshot':
          return await this.screenshot()
        case 'set_mode':
          return `Mode will be changed to ${args.mode}`
        default:
          throw new Error(`Unknown tool: ${toolName}`)
      }
    } catch (error: any) {
      throw error
    }
  }

  private async readFile(args: { path: string; start_line?: number; end_line?: number }): Promise<string> {
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

    const numberedContent = lines.map((line, i) => `${i + 1}: ${line}`).join('\n')
    return numberedContent
  }

  private async writeFile(args: { path: string; content: string }): Promise<string> {
    const filePath = this.resolvePath(args.path)
    const dir = path.dirname(filePath)

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(filePath, args.content, 'utf-8')
    return `Successfully wrote to ${args.path}`
  }

  private async editFile(args: { path: string; old_text: string; new_text: string }): Promise<string> {
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

  private async listFiles(args: { path: string; recursive?: boolean }): Promise<string> {
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

  private async searchFiles(args: { pattern: string; path?: string }): Promise<string> {
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

  private async runCommand(args: { command: string; cwd?: string }): Promise<string> {
    const cwd = args.cwd ? this.resolvePath(args.cwd) : this.homeDir

    try {
      const { stdout, stderr } = await execAsync(args.command, {
        cwd,
        maxBuffer: 1024 * 1024,
        timeout: 60000
      })
      const output = stdout + (stderr ? `\n${stderr}` : '')
      return output.slice(0, 10000)
    } catch (error: any) {
      throw error
    }
  }

  private async openApplication(args: { application_name: string }): Promise<string> {
    try {
      await shell.openPath(args.application_name)
      return `Opened ${args.application_name}`
    } catch (error: any) {
      throw error
    }
  }

  private async openUrl(args: { url: string }): Promise<string> {
    try {
      await shell.openExternal(args.url)
      return `Opened ${args.url}`
    } catch (error: any) {
      throw error
    }
  }

  private clipboardRead(): string {
    const text = clipboard.readText()
    return text || '(clipboard is empty)'
  }

  private clipboardWrite(args: { text: string }): string {
    clipboard.writeText(args.text)
    return 'Copied to clipboard'
  }

  private getSystemInfo(): string {
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

  private async screenshot(): Promise<string> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })

      if (sources.length > 0) {
        const dataUrl = sources[0].thumbnail.toDataURL()
        return dataUrl
      }
      throw new Error('No screen found')
    } catch (error: any) {
      throw error
    }
  }
}
