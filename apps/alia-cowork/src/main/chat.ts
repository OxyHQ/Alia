/**
 * Chat Provider using AI SDK with Alia Custom Provider
 * Streams responses from /v1/chat/completions using AI SDK
 */

import { BrowserWindow } from 'electron'
import { streamText } from 'ai'
import { ToolExecutor, createAISDKTools } from './tools'
import { createAlia } from './alia-provider'
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
  private messages: Array<any> = []
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
      // Create Alia provider
      const alia = createAlia({ apiKey, baseUrl })

      // Create AI SDK tools
      const tools = enableTools ? createAISDKTools(this.toolExecutor) : undefined

      // Create abort controller
      this.abortController = new AbortController()

      // Stream with AI SDK
      const result = streamText({
        model: alia(selectedModel),
        system: systemMessage,
        messages: this.messages,
        tools,
        abortSignal: this.abortController.signal,
        maxRetries: 2,
        temperature: 0.7,
        maxOutputTokens: 4096,
        onChunk: async ({ chunk }) => {
          if (chunk.type === 'text') {
            // Extract thinking tags for chain-of-thought
            const thinkingMatch = chunk.text.match(/<thinking>([\s\S]*?)<\/thinking>/g)
            if (thinkingMatch) {
              for (const match of thinkingMatch) {
                const content = match.replace(/<\/?thinking>/g, '').trim()
                if (content) {
                  this.send('chat:thinking', { content })
                }
              }
            }

            // Filter out thinking tags from main message
            const filtered = chunk.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
            if (filtered.trim()) {
              this.send('chat:stream', { content: filtered })
            }
          } else if (chunk.type === 'tool-call') {
            console.log('[ChatProvider] Tool call:', chunk.toolName, chunk.input)

            // Handle set_mode specially
            if (chunk.toolName === 'set_mode') {
              this.currentMode = (chunk.input as any).mode
              this.send('chat:modeChanged', { mode: this.currentMode })
            }

            this.send('chat:tool', {
              tool: chunk.toolName,
              args: chunk.input,
              status: 'running'
            })
          } else if (chunk.type === 'tool-result') {
            const success = !String(chunk.output).includes('Error:')
            this.send('chat:toolResult', {
              tool: chunk.toolName,
              success,
              result: String(chunk.output).slice(0, 500)
            })
          }
        },
        onError: (event) => {
          console.error('[ChatProvider] Stream error:', event.error)
          const error = event.error instanceof Error ? event.error : new Error(String(event.error))
          this.send('chat:error', {
            message: this.formatErrorMessage(error)
          })
        }
      })

      // Wait for completion and get final text
      const finalText = await result.text

      // Add assistant message to history
      if (finalText) {
        this.messages.push({ role: 'assistant', content: finalText })
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
