import { BrowserWindow } from 'electron'
import { CoreMessage } from 'ai'
import { ToolExecutor, createAISDKTools } from './tools'
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
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/v1/chat/completions`)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      // Prepare OpenAI-compatible request
      const requestBody = {
        model: modelId,
        messages: [
          { role: 'system', content: systemMessage },
          ...this.messages
        ],
        stream: true,
        temperature: 0.7
      }

      const postData = JSON.stringify(requestBody)

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'text/event-stream'
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

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop() || '' // Keep incomplete line in buffer

            for (const line of lines) {
              if (!line.trim() || line.trim() === 'data: [DONE]') continue
              if (!line.startsWith('data: ')) continue

              try {
                const json = JSON.parse(line.slice(6))
                const choice = json.choices?.[0]
                if (!choice) continue

                const delta = choice.delta

                // Handle reasoning chunks
                if (delta.reasoning) {
                  this.send('chat:thinking', { content: delta.reasoning })
                  console.log('[ChatProvider] Reasoning:', delta.reasoning.slice(0, 100))
                }

                // Handle content chunks
                if (delta.content) {
                  assistantMessage += delta.content
                  this.send('chat:stream', { content: delta.content })
                }

                // Handle tool calls
                if (delta.tool_calls) {
                  for (const toolCall of delta.tool_calls) {
                    if (toolCall.function) {
                      const toolName = toolCall.function.name
                      const args = JSON.parse(toolCall.function.arguments || '{}')

                      this.send('chat:tool', {
                        tool: toolName,
                        args,
                        status: 'running'
                      })

                      // Execute tool
                      this.toolExecutor.execute(toolName, args).then(result => {
                        this.send('chat:toolResult', {
                          tool: toolName,
                          success: result.success,
                          result: result.result
                        })

                        // Handle set_mode specially
                        if (toolName === 'set_mode' && result.success) {
                          this.currentMode = args.mode
                          this.send('chat:modeChanged', { mode: args.mode })
                        }
                      })
                    }
                  }
                }

                // Handle finish
                if (choice.finish_reason) {
                  console.log('[ChatProvider] Finished:', choice.finish_reason)
                }

                // Handle usage metadata
                if (json.usage) {
                  console.log('[ChatProvider] Usage:', json.usage)
                }
              } catch (err) {
                console.error('[ChatProvider] Parse error:', err)
              }
            }
          })

          res.on('end', () => {
            // Add assistant message to history
            if (assistantMessage) {
              this.messages.push({ role: 'assistant', content: assistantMessage })
            }
            this.send('chat:end', {})
            resolve()
          })

          res.on('error', (err) => {
            console.error('[ChatProvider] Response error:', err)
            reject(err)
          })
        }
      )

      req.on('error', (err) => {
        console.error('[ChatProvider] Request error:', err)
        reject(err)
      })

      req.write(postData)
      req.end()
    })
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
