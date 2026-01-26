import { BrowserWindow } from 'electron'
import { streamText, CoreMessage } from 'ai'
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
  private messages: CoreMessage[] = []
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
      await this.processConversation(baseUrl, apiKey, selectedModel, systemMessage)
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

  private async processConversation(
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

    // Prepare messages with system message
    const messagesWithSystem: CoreMessage[] = [
      { role: 'system', content: systemMessage },
      ...this.messages
    ]

    // Create abort controller for cancellation
    this.abortController = new AbortController()

    // Create AI SDK tools
    const tools = enableTools ? createAISDKTools(this.toolExecutor) : undefined

    try {
      // Track token usage
      let totalPromptTokens = 0
      let totalCompletionTokens = 0
      let totalTokens = 0

      // Stream with AI SDK - Enhanced with retry logic, caching, and error handling
      const result = streamText({
        model: resolved.model,
        messages: messagesWithSystem,
        tools,
        maxSteps: 10, // Allow up to 10 tool call iterations
        abortSignal: this.abortController.signal,

        // Enhanced call options
        maxRetries: 3, // Retry failed API calls up to 3 times
        temperature: 0.7, // Control randomness
        maxTokens: 4096, // Limit response length
        topP: 0.95, // Nucleus sampling

        // Experimental: Prompt caching for Anthropic (reduces costs on repeated system messages)
        experimental_providerMetadata: resolved.provider === 'anthropic' ? {
          anthropic: {
            cacheControl: [
              { type: 'ephemeral' as const }
            ]
          }
        } : undefined,

        // Error handling
        onError: (error) => {
          console.error('[ChatProvider] Stream error:', error)
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
          } else if (event.finishReason === 'tool-calls') {
            console.log('[ChatProvider] Finished with tool calls, continuing...')
          }

          // Capture final usage
          if (event.usage) {
            totalPromptTokens = event.usage.promptTokens
            totalCompletionTokens = event.usage.completionTokens
            totalTokens = event.usage.totalTokens

            console.log('[ChatProvider] Final usage:', event.usage)

            // Report usage back to API for credit tracking
            await reportUsage(baseUrl, apiKey, resolved.sessionId, {
              promptTokens: totalPromptTokens,
              completionTokens: totalCompletionTokens,
              totalTokens
            })
          }
        }
      })

      let assistantMessage = ''
      let hasToolCalls = false
      let toolCallCount = 0
      const MAX_TOOL_ITERATIONS = 10

      // Stream the response
      for await (const chunk of result.fullStream) {
        if (!this.isProcessing) break

        if (chunk.type === 'text-delta') {
          // Filter out thinking tags or internal reasoning
          const filtered = chunk.textDelta.replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
          if (filtered.trim()) {
            assistantMessage += filtered
            this.send('chat:stream', { content: filtered })
          }
        } else if (chunk.type === 'tool-call') {
          hasToolCalls = true
          toolCallCount++
          console.log('[ChatProvider] Tool call:', chunk.toolName, chunk.args)

          // Warn if approaching limit
          if (toolCallCount >= MAX_TOOL_ITERATIONS - 2) {
            this.send('chat:warning', {
              message: 'Approaching tool call limit, wrapping up...'
            })
          }

          // Handle set_mode specially
          if (chunk.toolName === 'set_mode') {
            const newMode = (chunk.args as any).mode
            if (['ask', 'edit', 'plan', 'yolo'].includes(newMode)) {
              this.currentMode = newMode
              this.send('chat:modeChanged', { mode: newMode })
            }
          }

          this.send('chat:tool', {
            tool: chunk.toolName,
            args: chunk.args,
            status: 'running'
          })
        } else if (chunk.type === 'tool-result') {
          console.log('[ChatProvider] Tool result:', chunk.toolName, 'success:', !chunk.result.includes('Error:'))

          const success = chunk.result && typeof chunk.result === 'string' && !chunk.result.includes('Error:')
          this.send('chat:toolResult', {
            tool: chunk.toolName,
            success,
            result: typeof chunk.result === 'string' ? chunk.result.slice(0, 500) : JSON.stringify(chunk.result).slice(0, 500)
          })
        } else if (chunk.type === 'finish') {
          console.log('[ChatProvider] Stream finished:', chunk.finishReason)
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

  private formatErrorMessage(error: Error): string {
    const message = error.message || 'An error occurred'

    // Map common errors to user-friendly messages
    if (message.includes('HTTP 402') || message.includes('Insufficient credits')) {
      return 'Insufficient credits. Please add more credits at alia.onl'
    } else if (message.includes('HTTP 401') || message.includes('Invalid API key')) {
      return 'Invalid API key. Please check your settings.'
    } else if (message.includes('HTTP 429') || message.includes('rate limit')) {
      return 'Rate limit exceeded. Please wait a moment and try again.'
    } else if (message.includes('HTTP 500')) {
      return 'Server error. Please try again later.'
    } else if (message.includes('HTTP 503')) {
      return 'Service unavailable. Please try again later.'
    } else if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
      return 'Request timed out. Please try again.'
    }

    return message
  }

  async getUserInfo(): Promise<any> {
    const apiKey = store.get('apiKey') as string
    const baseUrl = store.get('apiBaseUrl') as string

    if (!apiKey) return null

    const url = new URL(`${baseUrl}/v1/codea/me`)
    const isHttps = url.protocol === 'https:'
    const httpModule = isHttps ? require('https') : require('http')

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
    const httpModule = isHttps ? require('https') : require('http')

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
