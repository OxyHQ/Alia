/**
 * Chat Provider using OpenAI SDK
 * Streams responses using OpenAI SDK directly to Alia API
 */

import { BrowserWindow } from 'electron'
import OpenAI from 'openai'
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

export class ChatProvider {
  private window: BrowserWindow
  private toolExecutor: ToolExecutor
  private messages: Array<OpenAI.Chat.ChatCompletionMessageParam> = []
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

    // Add system message if this is the first message
    if (this.messages.length === 1) {
      this.messages.unshift({ role: 'system', content: this.buildSystemMessage() })
    }

    this.send('chat:start', {})

    try {
      // Create OpenAI client pointing to our API
      const openai = new OpenAI({
        apiKey,
        baseURL: `${baseUrl}/v1`,
        dangerouslyAllowBrowser: false // We're in Node/Electron
      })

      // Create abort controller
      this.abortController = new AbortController()

      // Define tools if enabled
      const tools: OpenAI.Chat.ChatCompletionTool[] | undefined = enableTools
        ? [
            {
              type: 'function',
              function: {
                name: 'read_file',
                description: 'Read the contents of a file from the filesystem',
                parameters: {
                  type: 'object',
                  properties: {
                    path: {
                      type: 'string',
                      description: 'Absolute or relative path to the file'
                    },
                    start_line: {
                      type: 'number',
                      description: 'Optional starting line (1-indexed)'
                    },
                    end_line: {
                      type: 'number',
                      description: 'Optional ending line (1-indexed)'
                    }
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
                    recursive: {
                      type: 'boolean',
                      description: 'List recursively'
                    }
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
                    application_name: {
                      type: 'string',
                      description: 'Application name or file path to open'
                    }
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
        : undefined

      // Stream with OpenAI SDK
      const stream = await openai.chat.completions.create(
        {
          model: selectedModel,
          messages: this.messages,
          tools,
          stream: true,
          temperature: 0.7,
          max_tokens: 4096
        },
        {
          signal: this.abortController.signal
        }
      )

      let assistantMessage = ''
      let toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []

      // Process stream chunks
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta

        if (!delta) continue

        // Handle reasoning (chain-of-thought)
        if ((delta as any).reasoning) {
          this.send('chat:thinking', { content: (delta as any).reasoning })
        }

        // Handle content
        if (delta.content) {
          assistantMessage += delta.content
          this.send('chat:stream', { content: delta.content })
        }

        // Handle tool calls
        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index ?? toolCalls.length
            if (!toolCalls[index]) {
              toolCalls[index] = {
                id: toolCall.id || '',
                type: 'function',
                function: { name: toolCall.function?.name || '', arguments: '' }
              }
            }

            if (toolCall.function?.name) {
              toolCalls[index].function.name = toolCall.function.name
            }

            if (toolCall.function?.arguments) {
              toolCalls[index].function.arguments += toolCall.function.arguments
            }

            if (toolCall.id) {
              toolCalls[index].id = toolCall.id
            }
          }
        }

        // Handle finish reason
        if (chunk.choices[0]?.finish_reason) {
          console.log('[ChatProvider] Stream finished:', chunk.choices[0].finish_reason)
        }
      }

      // Filter out undefined from sparse array before processing
      const validToolCalls = toolCalls.filter(tc => tc && tc.function)

      // Add assistant message to history (with tool calls if any)
      if (assistantMessage || validToolCalls.length > 0) {
        const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: assistantMessage || null
        }
        if (validToolCalls.length > 0) {
          assistantMsg.tool_calls = validToolCalls
        }
        this.messages.push(assistantMsg)
      }

      // Execute tools if there are tool calls
      if (validToolCalls.length > 0) {
        for (const toolCall of validToolCalls) {
          if (!toolCall || !toolCall.function) {
            console.error('[ChatProvider] Invalid tool call:', toolCall)
            continue
          }

          const toolName = toolCall.function.name
          if (!toolName) {
            console.error('[ChatProvider] Tool call missing name:', toolCall)
            continue
          }

          let args: any = {}
          try {
            args = JSON.parse(toolCall.function.arguments || '{}')
          } catch (e) {
            console.error('[ChatProvider] Failed to parse tool arguments:', toolCall.function.arguments, e)
            continue
          }

          // Handle set_mode specially
          if (toolName === 'set_mode') {
            this.currentMode = args.mode
            this.send('chat:modeChanged', { mode: this.currentMode })
          }

          this.send('chat:tool', {
            tool: toolName,
            args,
            status: 'running'
          })

          try {
            // Execute tool locally
            let result: string
            switch (toolName) {
              case 'read_file':
                result = await this.toolExecutor.readFile(args)
                break
              case 'write_file':
                result = await this.toolExecutor.writeFile(args)
                break
              case 'edit_file':
                result = await this.toolExecutor.editFile(args)
                break
              case 'list_files':
                result = await this.toolExecutor.listFiles(args)
                break
              case 'search_files':
                result = await this.toolExecutor.searchFiles(args)
                break
              case 'run_command':
                result = await this.toolExecutor.runCommand(args)
                break
              case 'open_application':
                result = await this.toolExecutor.openApplication(args)
                break
              case 'open_url':
                result = await this.toolExecutor.openUrl(args)
                break
              case 'clipboard_read':
                result = this.toolExecutor.clipboardRead()
                break
              case 'clipboard_write':
                result = this.toolExecutor.clipboardWrite(args)
                break
              case 'get_system_info':
                result = this.toolExecutor.getSystemInfo()
                break
              case 'screenshot':
                result = await this.toolExecutor.screenshot()
                break
              case 'set_mode':
                result = `Mode changed to ${args.mode}`
                break
              default:
                result = `Unknown tool: ${toolName}`
            }

            // Add tool result to messages
            this.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result
            })

            this.send('chat:toolResult', {
              tool: toolName,
              success: true,
              result: result.slice(0, 500)
            })
          } catch (error: any) {
            const errorMsg = error.message || String(error)
            this.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error: ${errorMsg}`
            })

            this.send('chat:toolResult', {
              tool: toolName,
              success: false,
              result: errorMsg
            })
          }
        }

        // Continue conversation with tool results - recursively call handleMessage
        // but without adding a new user message
        await this.continueWithToolResults(openai, selectedModel, tools)
      }

      this.send('chat:end', {})
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('[ChatProvider] Stream aborted by user')
        this.send('chat:end', {})
      } else {
        console.error('[ChatProvider] Stream error:', error)
        this.send('chat:error', { message: this.formatErrorMessage(error) })
      }
    } finally {
      this.isProcessing = false
      this.abortController = undefined
    }
  }

  private async continueWithToolResults(
    openai: OpenAI,
    model: string,
    tools: OpenAI.Chat.ChatCompletionTool[] | undefined
  ): Promise<void> {
    try {
      // Stream continuation with tool results
      const stream = await openai.chat.completions.create(
        {
          model,
          messages: this.messages,
          tools,
          stream: true,
          temperature: 0.7,
          max_tokens: 4096
        },
        {
          signal: this.abortController?.signal
        }
      )

      let assistantMessage = ''
      let toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []

      // Process stream chunks
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta

        if (!delta) continue

        // Handle reasoning
        if ((delta as any).reasoning) {
          this.send('chat:thinking', { content: (delta as any).reasoning })
        }

        // Handle content
        if (delta.content) {
          assistantMessage += delta.content
          this.send('chat:stream', { content: delta.content })
        }

        // Handle tool calls
        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index ?? toolCalls.length
            if (!toolCalls[index]) {
              toolCalls[index] = {
                id: toolCall.id || '',
                type: 'function',
                function: { name: toolCall.function?.name || '', arguments: '' }
              }
            }

            if (toolCall.function?.name) {
              toolCalls[index].function.name = toolCall.function.name
            }

            if (toolCall.function?.arguments) {
              toolCalls[index].function.arguments += toolCall.function.arguments
            }

            if (toolCall.id) {
              toolCalls[index].id = toolCall.id
            }
          }
        }
      }

      // Filter out undefined from sparse array before processing
      const validToolCalls = toolCalls.filter(tc => tc && tc.function)

      // Add assistant message
      if (assistantMessage || validToolCalls.length > 0) {
        const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: assistantMessage || null
        }
        if (validToolCalls.length > 0) {
          assistantMsg.tool_calls = validToolCalls
        }
        this.messages.push(assistantMsg)
      }

      // Execute more tools if needed (recursive)
      if (validToolCalls.length > 0) {
        for (const toolCall of validToolCalls) {
          const toolName = toolCall.function.name
          const args = JSON.parse(toolCall.function.arguments)

          if (toolName === 'set_mode') {
            this.currentMode = args.mode
            this.send('chat:modeChanged', { mode: this.currentMode })
          }

          this.send('chat:tool', {
            tool: toolName,
            args,
            status: 'running'
          })

          try {
            let result: string
            switch (toolName) {
              case 'read_file':
                result = await this.toolExecutor.readFile(args)
                break
              case 'write_file':
                result = await this.toolExecutor.writeFile(args)
                break
              case 'edit_file':
                result = await this.toolExecutor.editFile(args)
                break
              case 'list_files':
                result = await this.toolExecutor.listFiles(args)
                break
              case 'search_files':
                result = await this.toolExecutor.searchFiles(args)
                break
              case 'run_command':
                result = await this.toolExecutor.runCommand(args)
                break
              case 'open_application':
                result = await this.toolExecutor.openApplication(args)
                break
              case 'open_url':
                result = await this.toolExecutor.openUrl(args)
                break
              case 'clipboard_read':
                result = this.toolExecutor.clipboardRead()
                break
              case 'clipboard_write':
                result = this.toolExecutor.clipboardWrite(args)
                break
              case 'get_system_info':
                result = this.toolExecutor.getSystemInfo()
                break
              case 'screenshot':
                result = await this.toolExecutor.screenshot()
                break
              case 'set_mode':
                result = `Mode changed to ${args.mode}`
                break
              default:
                result = `Unknown tool: ${toolName}`
            }

            this.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result
            })

            this.send('chat:toolResult', {
              tool: toolName,
              success: true,
              result: result.slice(0, 500)
            })
          } catch (error: any) {
            const errorMsg = error.message || String(error)
            this.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error: ${errorMsg}`
            })

            this.send('chat:toolResult', {
              tool: toolName,
              success: false,
              result: errorMsg
            })
          }
        }

        // Continue recursively
        await this.continueWithToolResults(openai, model, tools)
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error('[ChatProvider] Tool continuation error:', error)
      }
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
