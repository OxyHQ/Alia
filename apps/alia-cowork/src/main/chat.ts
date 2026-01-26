/**
 * Chat Provider - Streams responses from /v1/chat/completions
 * Uses fetch to consume OpenAI-compatible SSE stream from backend API
 */

import { BrowserWindow } from 'electron'
import { ToolExecutor } from './tools'
import Store from 'electron-store'

const store = new Store({
  defaults: {
    apiKey: '',
    apiBaseUrl: 'https://api.alia.onl',
    model: 'alia-v1-cowork',
    enableTools: true
  }
})

interface Message {
  role: string
  content: string
  tool_calls?: any[]
}

interface ToolCall {
  id: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

export class ChatProvider {
  private window: BrowserWindow
  private toolExecutor: ToolExecutor
  private messages: Message[] = []
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
    const enableTools = store.get('enableTools') as boolean

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
      // Create abort controller
      this.abortController = new AbortController()

      // Build messages array with system message
      const allMessages: Message[] = [
        { role: 'system', content: systemMessage },
        ...this.messages
      ]

      // Convert tools to OpenAI format if enabled
      const tools = enableTools ? this.buildOpenAITools() : undefined

      // Make request to API
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: allMessages,
          tools,
          stream: true,
          temperature: 0.7,
          max_tokens: 4096
        }),
        signal: this.abortController.signal
      })

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`API Error: ${response.status} - ${error}`)
      }

      // Parse SSE stream
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accumulatedText = ''
      let accumulatedToolCalls: Map<string, ToolCall> = new Map()

      while (reader) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim() || line === 'data: [DONE]') continue
          if (!line.startsWith('data: ')) continue

          try {
            const data = JSON.parse(line.slice(6))
            const delta = data.choices?.[0]?.delta

            if (!delta) continue

            // Handle reasoning chunks
            if (delta.reasoning) {
              this.send('chat:thinking', { content: delta.reasoning })
            }

            // Handle content chunks
            if (delta.content) {
              accumulatedText += delta.content
              this.send('chat:stream', { content: delta.content })
            }

            // Handle tool calls
            if (delta.tool_calls) {
              for (const toolCall of delta.tool_calls) {
                const id = toolCall.id
                const name = toolCall.function?.name
                const args = toolCall.function?.arguments

                if (id && name) {
                  if (!accumulatedToolCalls.has(id)) {
                    accumulatedToolCalls.set(id, {
                      id,
                      type: 'function',
                      function: { name, arguments: args || '' }
                    })

                    // Handle set_mode specially
                    if (name === 'set_mode') {
                      try {
                        const parsedArgs = JSON.parse(args || '{}')
                        this.currentMode = parsedArgs.mode || this.currentMode
                        this.send('chat:modeChanged', { mode: this.currentMode })
                      } catch (e) {
                        console.error('[ChatProvider] Failed to parse set_mode args:', e)
                      }
                    }

                    this.send('chat:tool', {
                      tool: name,
                      args: args ? JSON.parse(args) : {},
                      status: 'running'
                    })

                    // Execute tool if we have an executor
                    if (enableTools) {
                      try {
                        const toolArgs = args ? JSON.parse(args) : {}
                        const result = await this.executeTool(name, toolArgs)

                        this.send('chat:toolResult', {
                          tool: name,
                          success: !String(result).includes('Error:'),
                          result: String(result).slice(0, 500)
                        })

                        // Add tool result to messages for next iteration
                        this.messages.push({
                          role: 'tool',
                          content: String(result),
                          tool_calls: [{
                            id,
                            type: 'function',
                            function: { name, arguments: args || '{}' }
                          }]
                        })
                      } catch (error: any) {
                        this.send('chat:toolResult', {
                          tool: name,
                          success: false,
                          result: error.message
                        })
                      }
                    }
                  } else if (args) {
                    // Accumulate arguments
                    const existing = accumulatedToolCalls.get(id)!
                    existing.function.arguments += args
                  }
                }
              }
            }

            // Handle finish
            if (data.choices?.[0]?.finish_reason) {
              // Add assistant message to history with tool calls if any
              const toolCallsArray = Array.from(accumulatedToolCalls.values())
              if (toolCallsArray.length > 0) {
                this.messages.push({
                  role: 'assistant',
                  content: accumulatedText,
                  tool_calls: toolCallsArray
                })
              } else if (accumulatedText) {
                this.messages.push({
                  role: 'assistant',
                  content: accumulatedText
                })
              }
            }
          } catch (error) {
            console.error('[ChatProvider] Parse error:', error)
          }
        }
      }

      this.send('chat:end', {})
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('[ChatProvider] Stream aborted by user')
        this.send('chat:end', {})
      } else {
        this.send('chat:error', { message: this.formatErrorMessage(error) })
      }
    } finally {
      this.isProcessing = false
      this.abortController = undefined
    }
  }

  private async executeTool(toolName: string, args: any): Promise<any> {
    // Map tool names to executor methods
    switch (toolName) {
      case 'read_file':
        return this.toolExecutor.readFile(args)
      case 'write_file':
        return this.toolExecutor.writeFile(args)
      case 'edit_file':
        return this.toolExecutor.editFile(args)
      case 'list_files':
        return this.toolExecutor.listFiles(args)
      case 'search_files':
        return this.toolExecutor.searchFiles(args)
      case 'run_command':
        return this.toolExecutor.runCommand(args)
      case 'open_application':
        return this.toolExecutor.openApplication(args)
      case 'open_url':
        return this.toolExecutor.openUrl(args)
      case 'clipboard_read':
        return this.toolExecutor.clipboardRead()
      case 'clipboard_write':
        return this.toolExecutor.clipboardWrite(args)
      case 'get_system_info':
        return this.toolExecutor.getSystemInfo()
      case 'screenshot':
        return this.toolExecutor.screenshot()
      case 'set_mode':
        return `Mode will be changed to ${args.mode}`
      default:
        throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  private buildOpenAITools(): any[] {
    return [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read the contents of a file from the filesystem',
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
          description: 'Create or overwrite a file with content',
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
          description: 'Replace specific text in a file',
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
          description: 'List files and directories in a path',
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
          description: 'Search for text patterns in files',
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
          description: 'Open an application or file with the default program',
          parameters: {
            type: 'object',
            properties: {
              application_name: { type: 'string', description: 'Application name or file path to open' }
            },
            required: ['application_name']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'open_url',
          description: 'Open a URL in the default browser',
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
          description: 'Read the current clipboard content',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'clipboard_write',
          description: 'Write text to the clipboard',
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
          description: 'Get system information (OS, CPU, memory, etc.)',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'screenshot',
          description: 'Take a screenshot of the screen',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'set_mode',
          description: 'Change the assistant operating mode',
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
