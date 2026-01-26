import { BrowserWindow } from 'electron'
import { streamText } from 'ai'
import { ToolExecutor, createAISDKTools } from './tools'
import { resolveModel, reportUsage } from './model-resolver'
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
  private messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = []
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
      let errorMessage = error.message || 'An error occurred'
      if (errorMessage.includes('HTTP 402') || errorMessage.includes('Insufficient credits')) {
        errorMessage = 'Insufficient credits. Please add more credits at alia.onl'
      } else if (errorMessage.includes('HTTP 401') || errorMessage.includes('Invalid API key')) {
        errorMessage = 'Invalid API key. Please check your settings.'
      }
      this.send('chat:error', { message: errorMessage })
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

    // Resolve model from API (gets provider key and model info)
    console.log('[ChatProvider] Resolving model:', modelId)
    const resolved = await resolveModel(baseUrl, apiKey, modelId)
    console.log('[ChatProvider] Resolved to:', resolved.provider, resolved.modelId)

    // Prepare messages
    const messagesWithSystem: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      { role: 'system', content: systemMessage },
      ...this.messages
    ]

    // Create abort controller for cancellation
    this.abortController = new AbortController()

    // Create AI SDK tools
    const tools = enableTools ? createAISDKTools(this.toolExecutor) : undefined

    try {
      // Stream with AI SDK - Enhanced with retry logic and error handling
      const result = streamText({
        model: resolved.model,
        messages: messagesWithSystem,
        tools,
        abortSignal: this.abortController.signal,

        // Enhanced call options
        maxRetries: 3,
        temperature: 0.7,
        maxOutputTokens: 4096,
        topP: 0.95,

        // Error handling
        onError: (event) => {
          console.error('[ChatProvider] Stream error:', event.error)
          const error = event.error instanceof Error ? event.error : new Error(String(event.error))
          this.send('chat:error', {
            message: this.formatErrorMessage(error),
            recoverable: error.name !== 'AbortError'
          })
        },

        // Finish handler
        onFinish: async (event) => {
          // Check finish reason
          if (event.finishReason === 'error') {
            this.send('chat:warning', { message: 'Response may be incomplete due to an error' })
          } else if (event.finishReason === 'length') {
            this.send('chat:warning', { message: 'Response truncated due to length limit' })
          }

          console.log('[ChatProvider] Final usage:', event.usage)

          // Report usage back to API for credit tracking
          if (event.usage && event.usage.totalTokens) {
            await reportUsage(baseUrl, apiKey, resolved.sessionId, {
              promptTokens: event.usage.promptTokens || 0,
              completionTokens: event.usage.completionTokens || 0,
              totalTokens: event.usage.totalTokens || 0
            }).catch(error => {
              console.error('[ChatProvider] Failed to report usage:', error)
            })
          }
        }
      })

      let assistantMessage = ''
      let toolCallCount = 0
      const MAX_TOOL_ITERATIONS = 10

      // Stream the response
      for await (const chunk of result.fullStream) {
        if (!this.isProcessing) break

        if (chunk.type === 'text-delta' && 'text' in chunk && chunk.text) {
          // Extract thinking tags for chain of thought visualization
          const thinkingMatch = chunk.text.match(/<thinking>([\s\S]*?)<\/thinking>/g)
          if (thinkingMatch) {
            thinkingMatch.forEach((match: string) => {
              const content = match.replace(/<\/?thinking>/g, '').trim()
              if (content) {
                this.send('chat:thinking', { content })
              }
            })
          }

          // Filter out thinking tags from the main message
          const filtered = chunk.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
          if (filtered.trim()) {
            assistantMessage += filtered
            this.send('chat:stream', { content: filtered })
          }
        } else if (chunk.type === 'tool-call') {
          toolCallCount++
          console.log('[ChatProvider] Tool call:', chunk.toolName, 'input' in chunk ? chunk.input : {})

          // Warn if approaching limit
          if (toolCallCount >= MAX_TOOL_ITERATIONS - 2) {
            this.send('chat:warning', {
              message: 'Approaching tool call limit, wrapping up...'
            })
          }

          // Handle set_mode specially
          if (chunk.toolName === 'set_mode' && 'input' in chunk) {
            const newMode = (chunk.input as any).mode
            if (['ask', 'edit', 'plan', 'yolo'].includes(newMode)) {
              this.currentMode = newMode
              this.send('chat:modeChanged', { mode: newMode })
            }
          }

          this.send('chat:tool', {
            tool: chunk.toolName,
            args: 'input' in chunk ? chunk.input : {},
            status: 'running'
          })
        } else if (chunk.type === 'tool-result') {
          const outputStr = 'output' in chunk && typeof chunk.output === 'string' ? chunk.output : JSON.stringify('output' in chunk ? chunk.output : '')
          console.log('[ChatProvider] Tool result:', chunk.toolName, 'success:', !outputStr.includes('Error:'))

          const success = outputStr && !outputStr.includes('Error:')
          this.send('chat:toolResult', {
            tool: chunk.toolName,
            success,
            result: outputStr.slice(0, 500)
          })
        } else if (chunk.type === 'finish') {
          console.log('[ChatProvider] Stream finished:', 'finishReason' in chunk ? chunk.finishReason : 'unknown')
        }
      }

      // Add assistant message to history
      const finalText = await result.text
      this.messages.push({ role: 'assistant', content: finalText })

      this.send('chat:end', {})
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('[ChatProvider] Stream aborted by user')
        this.send('chat:end', {})
      } else {
        throw error
      }
    } finally {
      this.abortController = undefined
    }
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

  async getUserInfo(): Promise<any> {
    const apiKey = store.get('apiKey') as string
    const baseUrl = store.get('apiBaseUrl') as string

    if (!apiKey) return null

    const url = new URL(`${baseUrl}/v1/codea/me`)
    const isHttps = url.protocol === 'https:'
    const httpModule = isHttps ? https : http

    return new Promise((resolve) => {
      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` }
        },
        (res: any) => {
          if (res.statusCode !== 200) {
            resolve(null)
            return
          }

          let data = ''
          res.on('data', (chunk: any) => (data += chunk))
          res.on('end', () => {
            try {
              resolve(JSON.parse(data))
            } catch {
              resolve(null)
            }
          })
        }
      )

      req.on('error', () => resolve(null))
      req.end()
    })
  }

  async getModels(): Promise<any[]> {
    const baseUrl = store.get('apiBaseUrl') as string
    const url = new URL(`${baseUrl}/v1/models?category=coding`)
    const isHttps = url.protocol === 'https:'
    const httpModule = isHttps ? https : http

    return new Promise((resolve) => {
      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'GET'
        },
        (res: any) => {
          if (res.statusCode !== 200) {
            resolve([])
            return
          }

          let data = ''
          res.on('data', (chunk: any) => (data += chunk))
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data)
              resolve(parsed.data || [])
            } catch {
              resolve([])
            }
          })
        }
      )

      req.on('error', () => resolve([]))
      req.end()
    })
  }
}
