import { exec, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { promisify } from 'util'
import { clipboard, shell, desktopCapturer } from 'electron'
import { tool } from 'ai'
import { z } from 'zod'

const execAsync = promisify(exec)

// OpenAI-format tool definitions (for backward compatibility if needed)
export const toolDefinitionsOpenAI = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file from the filesystem.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
          start_line: { type: 'number', description: 'Optional starting line (1-indexed)' },
          end_line: { type: 'number', description: 'Optional ending line (1-indexed)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          content: { type: 'string', description: 'Content to write' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace specific text in a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          old_text: { type: 'string', description: 'Text to find and replace' },
          new_text: { type: 'string', description: 'Replacement text' }
        },
        required: ['path', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories in a path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path' },
          recursive: { type: 'boolean', description: 'List recursively' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for text patterns in files.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search pattern' },
          path: { type: 'string', description: 'Directory to search in' },
          include: { type: 'string', description: 'File pattern to include (e.g., *.ts)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_application',
      description: 'Open an application or file with the default program.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Application name or file path to open' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open a URL in the default browser.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_read',
      description: 'Read the current clipboard content.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_write',
      description: 'Write text to the clipboard.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to copy to clipboard' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_system_info',
      description: 'Get system information (OS, CPU, memory, etc.).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Take a screenshot of the screen.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_mode',
      description: 'Change the assistant operating mode.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['ask', 'edit', 'plan', 'yolo'],
            description: 'The mode to switch to'
          }
        },
        required: ['mode']
      }
    }
  }
]

/**
 * Create AI SDK tool definitions with execute functions
 * This returns a function that creates tools with access to the ToolExecutor instance
 */
export function createAISDKTools(executor: ToolExecutor) {
  return {
    read_file: tool({
      description: 'Read the contents of a file from the filesystem.',
      parameters: z.object({
        path: z.string().describe('Absolute or relative path to the file'),
        start_line: z.number().optional().describe('Optional starting line (1-indexed)'),
        end_line: z.number().optional().describe('Optional ending line (1-indexed)')
      }),
      execute: async (params) => {
        const result = await executor.execute('read_file', params)
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    write_file: tool({
      description: 'Create or overwrite a file with content.',
      parameters: z.object({
        path: z.string().describe('Path to the file'),
        content: z.string().describe('Content to write')
      }),
      execute: async (params) => {
        const result = await executor.execute('write_file', params)
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    edit_file: tool({
      description: 'Replace specific text in a file.',
      parameters: z.object({
        path: z.string().describe('Path to the file'),
        old_text: z.string().describe('Text to find and replace'),
        new_text: z.string().describe('Replacement text')
      }),
      execute: async (params) => {
        const result = await executor.execute('edit_file', params)
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    list_files: tool({
      description: 'List files and directories in a path.',
      parameters: z.object({
        path: z.string().describe('Directory path'),
        recursive: z.boolean().optional().describe('List recursively')
      }),
      execute: async (params) => {
        const result = await executor.execute('list_files', params)
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    search_files: tool({
      description: 'Search for text patterns in files.',
      parameters: z.object({
        query: z.string().describe('Search pattern'),
        path: z.string().optional().describe('Directory to search in'),
        include: z.string().optional().describe('File pattern to include (e.g., *.ts)')
      }),
      execute: async (params) => {
        const result = await executor.execute('search_files', params)
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    run_command: tool({
      description: 'Execute a shell command.',
      parameters: z.object({
        command: z.string().describe('Shell command to execute'),
        cwd: z.string().optional().describe('Working directory')
      }),
      execute: async (params) => {
        const result = await executor.execute('run_command', params)
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    open_application: tool({
      description: 'Open an application or file with the default program.',
      parameters: z.object({
        path: z.string().describe('Application name or file path to open')
      }),
      execute: async (params) => {
        const result = await executor.execute('open_application', params)
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    open_url: tool({
      description: 'Open a URL in the default browser.',
      parameters: z.object({
        url: z.string().describe('URL to open')
      }),
      execute: async (params) => {
        const result = await executor.execute('open_url', params)
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    clipboard_read: tool({
      description: 'Read the current clipboard content.',
      parameters: z.object({}),
      execute: async () => {
        const result = executor.execute('clipboard_read', {})
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    clipboard_write: tool({
      description: 'Write text to the clipboard.',
      parameters: z.object({
        text: z.string().describe('Text to copy to clipboard')
      }),
      execute: async (params) => {
        const result = executor.execute('clipboard_write', params)
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    get_system_info: tool({
      description: 'Get system information (OS, CPU, memory, etc.).',
      parameters: z.object({}),
      execute: async () => {
        const result = executor.execute('get_system_info', {})
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    screenshot: tool({
      description: 'Take a screenshot of the screen.',
      parameters: z.object({}),
      execute: async () => {
        const result = await executor.execute('screenshot', {})
        if (!result.success) throw new Error(result.result)
        return result.result
      }
    }),

    set_mode: tool({
      description: 'Change the assistant operating mode.',
      parameters: z.object({
        mode: z.enum(['ask', 'edit', 'plan', 'yolo']).describe('The mode to switch to')
      }),
      execute: async (params) => {
        // This will be handled specially in ChatProvider
        return `Mode will be changed to ${params.mode}`
      }
    })
  }
}

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

  async execute(toolName: string, args: any): Promise<{ success: boolean; result: string }> {
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
        default:
          return { success: false, result: `Unknown tool: ${toolName}` }
      }
    } catch (error: any) {
      return { success: false, result: `Error: ${error.message}` }
    }
  }

  private async readFile(args: { path: string; start_line?: number; end_line?: number }): Promise<{ success: boolean; result: string }> {
    const filePath = this.resolvePath(args.path)

    if (!fs.existsSync(filePath)) {
      return { success: false, result: `File not found: ${args.path}` }
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    if (args.start_line || args.end_line) {
      const start = (args.start_line || 1) - 1
      const end = args.end_line || lines.length
      const selectedLines = lines.slice(start, end)
      return {
        success: true,
        result: selectedLines.map((line, i) => `${start + i + 1}: ${line}`).join('\n')
      }
    }

    const numberedContent = lines.map((line, i) => `${i + 1}: ${line}`).join('\n')
    return { success: true, result: numberedContent }
  }

  private async writeFile(args: { path: string; content: string }): Promise<{ success: boolean; result: string }> {
    const filePath = this.resolvePath(args.path)
    const dir = path.dirname(filePath)

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(filePath, args.content, 'utf-8')
    return { success: true, result: `Successfully wrote to ${args.path}` }
  }

  private async editFile(args: { path: string; old_text: string; new_text: string }): Promise<{ success: boolean; result: string }> {
    const filePath = this.resolvePath(args.path)

    if (!fs.existsSync(filePath)) {
      return { success: false, result: `File not found: ${args.path}` }
    }

    const content = fs.readFileSync(filePath, 'utf-8')

    if (!content.includes(args.old_text)) {
      return { success: false, result: `Could not find the specified text in ${args.path}` }
    }

    const newContent = content.replace(args.old_text, args.new_text)
    fs.writeFileSync(filePath, newContent, 'utf-8')

    return { success: true, result: `Successfully edited ${args.path}` }
  }

  private async listFiles(args: { path: string; recursive?: boolean }): Promise<{ success: boolean; result: string }> {
    const dirPath = this.resolvePath(args.path)

    if (!fs.existsSync(dirPath)) {
      return { success: false, result: `Directory not found: ${args.path}` }
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
    return { success: true, result: files.join('\n') }
  }

  private async searchFiles(args: { query: string; path?: string; include?: string }): Promise<{ success: boolean; result: string }> {
    const searchPath = this.resolvePath(args.path || '.')
    const platform = process.platform

    let command: string
    if (platform === 'win32') {
      command = `findstr /s /n /i "${args.query}" ${args.include || '*.*'}`
    } else {
      const includeArg = args.include ? `--include="${args.include}"` : ''
      command = `grep -rn ${includeArg} "${args.query}" .`
    }

    try {
      const { stdout } = await execAsync(command, { cwd: searchPath, maxBuffer: 1024 * 1024 })
      return { success: true, result: stdout.slice(0, 5000) }
    } catch (error: any) {
      if (error.code === 1) {
        return { success: true, result: 'No matches found' }
      }
      return { success: false, result: error.message }
    }
  }

  private async runCommand(args: { command: string; cwd?: string }): Promise<{ success: boolean; result: string }> {
    const cwd = args.cwd ? this.resolvePath(args.cwd) : this.homeDir

    try {
      const { stdout, stderr } = await execAsync(args.command, {
        cwd,
        maxBuffer: 1024 * 1024,
        timeout: 60000
      })
      const output = stdout + (stderr ? `\n${stderr}` : '')
      return { success: true, result: output.slice(0, 10000) }
    } catch (error: any) {
      return { success: false, result: error.message }
    }
  }

  private async openApplication(args: { path: string }): Promise<{ success: boolean; result: string }> {
    try {
      await shell.openPath(args.path)
      return { success: true, result: `Opened ${args.path}` }
    } catch (error: any) {
      return { success: false, result: error.message }
    }
  }

  private async openUrl(args: { url: string }): Promise<{ success: boolean; result: string }> {
    try {
      await shell.openExternal(args.url)
      return { success: true, result: `Opened ${args.url}` }
    } catch (error: any) {
      return { success: false, result: error.message }
    }
  }

  private clipboardRead(): { success: boolean; result: string } {
    const text = clipboard.readText()
    return { success: true, result: text || '(clipboard is empty)' }
  }

  private clipboardWrite(args: { text: string }): { success: boolean; result: string } {
    clipboard.writeText(args.text)
    return { success: true, result: 'Copied to clipboard' }
  }

  private getSystemInfo(): { success: boolean; result: string } {
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
    return { success: true, result: JSON.stringify(info, null, 2) }
  }

  private async screenshot(): Promise<{ success: boolean; result: string }> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })

      if (sources.length > 0) {
        const dataUrl = sources[0].thumbnail.toDataURL()
        return { success: true, result: dataUrl }
      }
      return { success: false, result: 'No screen found' }
    } catch (error: any) {
      return { success: false, result: error.message }
    }
  }
}
