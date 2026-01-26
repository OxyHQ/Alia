/**
 * Tool Definitions with AI SDK
 * Creates AI SDK-compatible tools that execute locally
 */

import { exec } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { promisify } from 'util'
import { clipboard, shell, desktopCapturer } from 'electron'
import { tool } from 'ai'
import { z } from 'zod'

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

  async screenshot(): Promise<string> {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })

    if (sources.length > 0) {
      return sources[0].thumbnail.toDataURL()
    }
    throw new Error('No screen found')
  }
}

/**
 * Create AI SDK tool definitions
 */
export function createAISDKTools(executor: ToolExecutor) {
  return {
    read_file: tool({
      description: 'Read the contents of a file from the filesystem',
      inputSchema: z.object({
        path: z.string().describe('Absolute or relative path to the file'),
        start_line: z.number().optional().describe('Optional starting line (1-indexed)'),
        end_line: z.number().optional().describe('Optional ending line (1-indexed)')
      }),
      execute: async ({ path, start_line, end_line }) => executor.readFile({ path, start_line, end_line })
    }),

    write_file: tool({
      description: 'Create or overwrite a file with content',
      inputSchema: z.object({
        path: z.string().describe('Path to the file'),
        content: z.string().describe('Content to write')
      }),
      execute: async ({ path, content }) => executor.writeFile({ path, content })
    }),

    edit_file: tool({
      description: 'Replace specific text in a file',
      inputSchema: z.object({
        path: z.string().describe('Path to the file'),
        old_text: z.string().describe('Text to find and replace'),
        new_text: z.string().describe('Replacement text')
      }),
      execute: async ({ path, old_text, new_text }) => executor.editFile({ path, old_text, new_text })
    }),

    list_files: tool({
      description: 'List files and directories in a path',
      inputSchema: z.object({
        path: z.string().describe('Directory path'),
        recursive: z.boolean().optional().describe('List recursively')
      }),
      execute: async ({ path, recursive }) => executor.listFiles({ path, recursive })
    }),

    search_files: tool({
      description: 'Search for text patterns in files',
      inputSchema: z.object({
        pattern: z.string().describe('Search pattern'),
        path: z.string().optional().describe('Directory to search in')
      }),
      execute: async ({ pattern, path }) => executor.searchFiles({ pattern, path })
    }),

    run_command: tool({
      description: 'Execute a shell command',
      inputSchema: z.object({
        command: z.string().describe('Shell command to execute'),
        cwd: z.string().optional().describe('Working directory')
      }),
      execute: async ({ command, cwd }) => executor.runCommand({ command, cwd })
    }),

    open_application: tool({
      description: 'Open an application or file with the default program',
      inputSchema: z.object({
        application_name: z.string().describe('Application name or file path to open')
      }),
      execute: async ({ application_name }) => executor.openApplication({ application_name })
    }),

    open_url: tool({
      description: 'Open a URL in the default browser',
      inputSchema: z.object({
        url: z.string().describe('URL to open')
      }),
      execute: async ({ url }) => executor.openUrl({ url })
    }),

    clipboard_read: tool({
      description: 'Read the current clipboard content',
      inputSchema: z.object({}),
      execute: async () => executor.clipboardRead()
    }),

    clipboard_write: tool({
      description: 'Write text to the clipboard',
      inputSchema: z.object({
        text: z.string().describe('Text to copy to clipboard')
      }),
      execute: async ({ text }) => executor.clipboardWrite({ text })
    }),

    get_system_info: tool({
      description: 'Get system information (OS, CPU, memory, etc.)',
      inputSchema: z.object({}),
      execute: async () => executor.getSystemInfo()
    }),

    screenshot: tool({
      description: 'Take a screenshot of the screen',
      inputSchema: z.object({}),
      execute: async () => executor.screenshot()
    }),

    set_mode: tool({
      description: 'Change the assistant operating mode',
      inputSchema: z.object({
        mode: z.enum(['ask', 'edit', 'plan', 'yolo']).describe('The mode to switch to')
      }),
      execute: async ({ mode }) => `Mode will be changed to ${mode}`
    })
  }
}
