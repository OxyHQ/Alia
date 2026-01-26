/**
 * Chat Provider - Uses Alia API /v1/chat/completions endpoint
 * All model resolution and provider logic handled server-side
 */

import { BrowserWindow } from 'electron'
import { ToolExecutor } from './tools'
import Store from 'electron-store'
import * as https from 'https'
import * as http from 'http'

const store = new Store({
  defaults: {
    apiKey: '',
    apiBaseUrl: 'https://api.alia.onl',
    model: 'alia-v1-cowork',
    enableTools: true
  }
})

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

interface ToolResult {
  role: 'tool'
  tool_call_id: string
  content: string
}

export class ChatProvider {
  private window: BrowserWindow
  private toolExecutor: ToolExecutor
  private messages: Array<Message | ToolResult> = []
  private isProcessing = false
  private currentMode = 'ask'
  private abortController?: AbortController

  constructor(window: BrowserWindow, toolExecutor: ToolExecutor) {
    this.window = window
    this.toolExecutor = toolExecutor
  }

  private send(channel: string, data: any): void {
    this.window.webContents.send(channel, data)
  }

  async handleMessage(
    content: string,
    mode: string = 'ask',
    model?: string,
    context?: any[]
  ): Promise<void> {
    if (this.isProcessing) return

    const apiKey = store.get('apiKey') as string
    const baseUrl = store.get('apiBaseUrl') as string
    const selectedModel = model || (store.get('model') as string)

    if (!apiKey) {
      this.send('chat:error', { message: 'Please set your API key in settings' })
      return
    }

    this.currentMode = mode
    this.isProcessing = true

    // Build user message with context
    let enhancedContent = content
    if (context && context.length > 0) {
      for (const item of context) {
        enhancedContent += `\n\n**File: ${item.path}**\n\`\`\`${item.language || ''}\n${item.content}\n\`\`\``
      }
    }

    this.messages.push({ role: 'user', content: enhancedContent })
    const systemMessage = this.buildSystemMessage()

    this.send('chat:start', {})

    try {
      await this.streamFromAPI(baseUrl, apiKey, selectedModel, systemMessage)
    } catch (error: any) {
      this.send('chat:error', { message: this.formatErrorMessage(error) })
    } finally {
      this.isProcessing = false
    }
  }

  private buildSystemMessage(): string {
    const enableTools = store.get('enableTools') as boolean

    let systemMessage = `You are Alia Cowork, an AI assistant for desktop productivity. Be concise and helpful.

## Response Style
- Be brief and direct
- Provide clear, actionable answers
- Use a friendly but professional tone

## Platform
You are running on ${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'}.`

    if (enableTools) {
      systemMessage += `

## Critical Rules
1. **NEVER ask follow-up questions** - Just execute the task directly.
2. **NEVER show diffs or ask for approval** - Execute changes directly with tools.
3. **Use tools proactively** - You have full access to the filesystem and can run commands.

## Available Tools
- **read_file**: Read file contents
- **write_file**: Create/overwrite files
- **edit_file**: Replace text in files
- **list_files**: List directory contents
- **search_files**: Search for patterns
- **run_command**: Execute shell commands
- **open_application**: Open apps or files
- **open_url**: Open URLs in browser
- **clipboard_read/write**: Access clipboard
- **get_system_info**: Get system details
- **screenshot**: Capture screen
- **set_mode**: Change operating mode`

      if (this.currentMode === 'ask') {
        systemMessage += `\n\n## Mode: ASK\nConfirm destructive operations only.`
      } else if (this.currentMode === 'edit') {
        systemMessage += `\n\n## Mode: EDIT\nMake changes directly without confirmation.`
      } else if (this.currentMode === 'yolo') {
        systemMessage += `\n\n## Mode: YOLO\nFull autonomous mode. Execute everything.`
      }
    }

    return systemMessage
  }

  private async streamFromAPI(
    baseUrl: string,
    apiKey: string,
    modelId: string,
    systemMessage: string
  ): Promise<void> {
    const enableTools = store.get('enableTools') as boolean

    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/v1/chat/completions`)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      // Prepare messages with system message
      const messages: Array<Message | ToolResult> = [
        { role: 'system', content: systemMessage },
        ...this.messages
      ]

      // Prepare tools in OpenAI format
      const tools = enableTools ? this.getToolsSchema() : undefined

      const postData = JSON.stringify({
        model: modelId,
        messages,
        tools,
        stream: true,
        temperature: 0.7,
        max_tokens: 4096
      })

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            Authorization: `Bearer ${apiKey}`
          }
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errorData = ''
            res.on('data', (chunk) => (errorData += chunk))
            res.on('end', () => {
              try {
                const error = JSON.parse(errorData)
                reject(new Error(error.error || `HTTP ${res.statusCode}`))
              } catch {
                reject(new Error(`HTTP ${res.statusCode}`))
              }
            })
            return
          }

          let buffer = ''
          let assistantMessage = ''
          const toolCalls: Map<string, { name: string; arguments: string }> = new Map()

          res.on('data', (chunk: Buffer) => {
            if (!this.isProcessing) {
              res.destroy()
              resolve()
              return
            }

            buffer += chunk.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (!line.trim() || line.trim() === 'data: [DONE]') continue
              if (!line.startsWith('data: ')) continue

              try {
                const json = JSON.parse(line.slice(6))
                const delta = json.choices?.[0]?.delta

                if (!delta) continue

                // Handle reasoning chunks (from API server)
                if (delta.reasoning) {
                  this.send('chat:thinking', { content: delta.reasoning })
                }

                // Handle content chunks
                if (delta.content) {
                  assistantMessage += delta.content
                  this.send('chat:stream', { content: delta.content })
                }

                // Handle tool calls
                if (delta.tool_calls) {
                  for (const toolCall of delta.tool_calls) {
                    const id = toolCall.id || `call_${Date.now()}`

                    if (!toolCalls.has(id)) {
                      toolCalls.set(id, { name: '', arguments: '' })
                    }

                    const tc = toolCalls.get(id)!

                    if (toolCall.function?.name) {
                      tc.name = toolCall.function.name
                    }

                    if (toolCall.function?.arguments) {
                      tc.arguments += toolCall.function.arguments
                    }
                  }
                }

                // Handle finish
                if (json.choices?.[0]?.finish_reason === 'tool_calls') {
                  // Execute tools
                  this.executeTools(toolCalls, assistantMessage).then((hasMore) => {
                    if (hasMore) {
                      // Continue conversation with tool results
                      this.streamFromAPI(baseUrl, apiKey, modelId, systemMessage).then(resolve).catch(reject)
                    } else {
                      resolve()
                    }
                  }).catch(reject)
                  return
                } else if (json.choices?.[0]?.finish_reason) {
                  // Normal finish
                  if (assistantMessage) {
                    this.messages.push({ role: 'assistant', content: assistantMessage })
                  }
                  this.send('chat:end', {})
                  resolve()
                  return
                }
              } catch (error) {
                console.error('[ChatProvider] Parse error:', error)
              }
            }
          })

          res.on('end', () => {
            if (assistantMessage) {
              this.messages.push({ role: 'assistant', content: assistantMessage })
            }
            this.send('chat:end', {})
            resolve()
          })

          res.on('error', reject)
        }
      )

      req.on('error', reject)
      req.write(postData)
      req.end()

      // Handle abort
      this.abortController = new AbortController()
      this.abortController.signal.addEventListener('abort', () => {
        req.destroy()
        resolve()
      })
    })
  }

  private async executeTools(
    toolCalls: Map<string, { name: string; arguments: string }>,
    assistantMessage: string
  ): Promise<boolean> {
    if (toolCalls.size === 0) return false

    // Add assistant message with tool calls
    const toolCallsArray = Array.from(toolCalls.entries()).map(([id, tc]) => ({
      id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments }
    }))

    this.messages.push({
      role: 'assistant',
      content: assistantMessage || '',
      tool_calls: toolCallsArray
    })

    // Execute each tool
    for (const [id, tc] of toolCalls.entries()) {
      this.send('chat:tool', {
        tool: tc.name,
        args: tc.arguments ? JSON.parse(tc.arguments) : {},
        status: 'running'
      })

      try {
        const args = tc.arguments ? JSON.parse(tc.arguments) : {}
        const result = await this.toolExecutor.execute(tc.name, args)

        this.send('chat:toolResult', {
          tool: tc.name,
          success: true,
          result: String(result).slice(0, 500)
        })

        // Add tool result to messages
        this.messages.push({
          role: 'tool',
          tool_call_id: id,
          content: String(result)
        })

        // Handle set_mode specially
        if (tc.name === 'set_mode' && args.mode) {
          this.currentMode = args.mode
          this.send('chat:modeChanged', { mode: args.mode })
        }
      } catch (error: any) {
        this.send('chat:toolResult', {
          tool: tc.name,
          success: false,
          result: `Error: ${error.message}`
        })

        this.messages.push({
          role: 'tool',
          tool_call_id: id,
          content: `Error: ${error.message}`
        })
      }
    }

    return true
  }

  private getToolsSchema(): any[] {
    return [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read the contents of a file',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path to read' }
            },
            required: ['path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write content to a file (creates or overwrites)',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path to write' },
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
          description: 'Edit a file by replacing text',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path' },
              old_text: { type: 'string', description: 'Text to replace' },
              new_text: { type: 'string', description: 'New text' }
            },
            required: ['path', 'old_text', 'new_text']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'list_files',
          description: 'List files in a directory',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Directory path' }
            },
            required: ['path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_files',
          description: 'Search for a pattern in files',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Search pattern' },
              path: { type: 'string', description: 'Directory to search in' }
            },
            required: ['pattern']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'run_command',
          description: 'Execute a shell command',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Command to execute' }
            },
            required: ['command']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'open_application',
          description: 'Open an application or file',
          parameters: {
            type: 'object',
            properties: {
              application_name: { type: 'string', description: 'Application name or file path' }
            },
            required: ['application_name']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'open_url',
          description: 'Open a URL in the browser',
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
          description: 'Read from clipboard',
          parameters: { type: 'object', properties: {}, required: [] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'clipboard_write',
          description: 'Write to clipboard',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Text to copy' }
            },
            required: ['text']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_system_info',
          description: 'Get system information',
          parameters: { type: 'object', properties: {}, required: [] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'screenshot',
          description: 'Capture a screenshot',
          parameters: { type: 'object', properties: {}, required: [] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'set_mode',
          description: 'Change the operating mode',
          parameters: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['ask', 'edit', 'plan', 'yolo'],
                description: 'Operating mode'
              }
            },
            required: ['mode']
          }
        }
      }
    ]
  }

  stop(): void {
    this.isProcessing = false
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = undefined
    }
    this.send('chat:end', {})
  }

  clear(): void {
    this.messages = []
    this.send('chat:cleared', {})
  }

  private formatErrorMessage(error: Error): string {
    const message = error.message || 'An error occurred'

    if (message.includes('402') || message.toLowerCase().includes('insufficient credits')) {
      return 'Insufficient credits. Please add more credits at alia.onl'
    } else if (message.includes('401') || message.toLowerCase().includes('unauthorized')) {
      return 'Invalid API key. Please check your settings.'
    } else if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
      return 'Rate limit exceeded. Please wait a moment and try again.'
    } else if (message.includes('500')) {
      return 'Server error. Please try again later.'
    } else if (message.includes('503')) {
      return 'Service unavailable. Please try again later.'
    }

    return message
  }

  async getUserInfo(): Promise<any> {
    const apiKey = store.get('apiKey') as string
    const baseUrl = store.get('apiBaseUrl') as string

    if (!apiKey) return null

    try {
      const response = await fetch(`${baseUrl}/v1/codea/me`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      })

      if (!response.ok) return null

      return await response.json()
    } catch {
      return null
    }
  }

  async getModels(): Promise<any[]> {
    const baseUrl = store.get('apiBaseUrl') as string

    try {
      const response = await fetch(`${baseUrl}/v1/models?category=coding`)

      if (!response.ok) return []

      const data = await response.json()
      return data.data || []
    } catch {
      return []
    }
  }
}
