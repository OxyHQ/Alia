import { BrowserWindow } from 'electron'
import * as https from 'https'
import * as http from 'http'
import { ToolExecutor, toolDefinitions } from './tools'
import Store from 'electron-store'

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

const store = new Store({
  defaults: {
    apiKey: '',
    apiBaseUrl: 'https://api.alia.onl',
    model: 'alia-v1-cowork',
    enableTools: true  // Tools enabled for alia-v1-cowork model
  }
})

export class ChatProvider {
  private window: BrowserWindow
  private toolExecutor: ToolExecutor
  private messages: Message[] = []
  private isProcessing = false
  private currentRequest?: { abort: () => void }
  private currentMode = 'ask'

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
    await this.processConversation(baseUrl, apiKey, selectedModel, systemMessage)
    this.isProcessing = false
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

    // Only include tool instructions if tools are enabled
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
    model: string,
    systemMessage: string
  ): Promise<void> {
    let isFirstIteration = true

    while (this.isProcessing) {
      if (isFirstIteration) {
        isFirstIteration = false
      }

      try {
        const result = await this.streamChatCompletion(baseUrl, apiKey, model, systemMessage)

        if (!this.isProcessing) break

        if (result.toolCalls && result.toolCalls.length > 0) {
          this.messages.push({
            role: 'assistant',
            content: result.content,
            tool_calls: result.toolCalls
          })

          for (const toolCall of result.toolCalls) {
            if (!this.isProcessing) break

            const args = JSON.parse(toolCall.function.arguments)

            this.send('chat:tool', {
              tool: toolCall.function.name,
              args,
              status: 'running'
            })

            let toolResult: { success: boolean; result: string }

            if (toolCall.function.name === 'set_mode') {
              const newMode = args.mode
              if (['ask', 'edit', 'plan', 'yolo'].includes(newMode)) {
                this.currentMode = newMode
                this.send('chat:modeChanged', { mode: newMode })
                toolResult = { success: true, result: `Mode changed to ${newMode}` }
              } else {
                toolResult = { success: false, result: `Invalid mode: ${newMode}` }
              }
            } else {
              toolResult = await this.toolExecutor.execute(toolCall.function.name, args)
            }

            this.send('chat:toolResult', {
              tool: toolCall.function.name,
              success: toolResult.success,
              result: toolResult.result.slice(0, 500)
            })

            this.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: toolResult.result
            })
          }

          continue
        } else {
          this.messages.push({ role: 'assistant', content: result.content })
          this.send('chat:end', {})
          break
        }
      } catch (error: any) {
        let errorMessage = error.message || 'An error occurred'
        if (errorMessage.includes('HTTP 402')) {
          errorMessage = 'Insufficient credits. Please add more credits at alia.onl'
        } else if (errorMessage.includes('HTTP 401')) {
          errorMessage = 'Invalid API key. Please check your settings.'
        }
        this.send('chat:error', { message: errorMessage })
        break
      }
    }
  }

  private streamChatCompletion(
    baseUrl: string,
    apiKey: string,
    model: string,
    systemMessage: string
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/v1/chat/completions`)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const messagesWithSystem: Message[] = [
        { role: 'system', content: systemMessage },
        ...this.messages
      ]

      const enableTools = store.get('enableTools') as boolean

      const requestBody = JSON.stringify({
        model,
        messages: messagesWithSystem.map((m) => {
          if (m.tool_calls) {
            return { role: m.role, content: m.content || '', tool_calls: m.tool_calls }
          } else if (m.tool_call_id) {
            return { role: m.role, tool_call_id: m.tool_call_id, name: m.name, content: m.content }
          }
          return { role: m.role, content: m.content }
        }),
        stream: true,
        ...(enableTools && {
          tools: toolDefinitions,
          tool_choice: 'auto'
        })
      })

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(requestBody)
        }
      }

      let fullContent = ''
      const toolCalls: ToolCall[] = []
      let currentToolCall: ToolCall | null = null

      const req = httpModule.request(options, (res) => {
        console.log('[ChatProvider] Response status:', res.statusCode)
        console.log('[ChatProvider] Response headers:', JSON.stringify(res.headers))

        if (res.statusCode !== 200) {
          let errorBody = ''
          res.on('data', (chunk) => (errorBody += chunk))
          res.on('end', () => {
            console.log('[ChatProvider] Error response body:', errorBody)
            try {
              const error = JSON.parse(errorBody)
              reject(new Error(`HTTP ${res.statusCode}: ${error.error?.message || ''}`))
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${errorBody}`))
            }
          })
          return
        }

        let buffer = ''

        res.on('data', (chunk: Buffer) => {
          if (!this.isProcessing) return

          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              if (data === '[DONE]') {
                console.log('[ChatProvider] Received [DONE]')
                continue
              }

              try {
                const parsed = JSON.parse(data)
                console.log('[ChatProvider] Parsed chunk:', JSON.stringify(parsed).substring(0, 200))
                const choice = parsed.choices?.[0]

                if (!parsed.choices || parsed.choices.length === 0) {
                  console.log('[ChatProvider] No choices in response:', JSON.stringify(parsed))
                }

                if (choice?.delta?.content) {
                  fullContent += choice.delta.content
                  this.send('chat:stream', { content: choice.delta.content })
                }

                if (choice?.delta?.tool_calls) {
                  for (const tc of choice.delta.tool_calls) {
                    if (tc.id) {
                      currentToolCall = {
                        id: tc.id,
                        type: 'function',
                        function: {
                          name: tc.function?.name || '',
                          arguments: tc.function?.arguments || ''
                        }
                      }
                      toolCalls.push(currentToolCall)

                      if (currentToolCall.function.name) {
                        this.send('chat:tool', {
                          tool: currentToolCall.function.name,
                          args: {},
                          status: 'preparing'
                        })
                      }
                    } else if (currentToolCall) {
                      if (tc.function?.name) {
                        currentToolCall.function.name = tc.function.name
                        this.send('chat:tool', {
                          tool: currentToolCall.function.name,
                          args: {},
                          status: 'preparing'
                        })
                      }
                      if (tc.function?.arguments) {
                        currentToolCall.function.arguments += tc.function.arguments
                      }
                    }
                  }
                }
              } catch {
                // Skip malformed JSON
              }
            }
          }
        })

        res.on('end', () => {
          console.log('[ChatProvider] Response ended. Full content length:', fullContent.length, 'Tool calls:', toolCalls.length)
          this.currentRequest = undefined
          resolve({ content: fullContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined })
        })
      })

      req.on('error', (error) => {
        this.currentRequest = undefined
        reject(error)
      })

      this.currentRequest = {
        abort: () => req.destroy()
      }

      req.write(requestBody)
      req.end()
    })
  }

  stop(): void {
    this.isProcessing = false
    if (this.currentRequest) {
      this.currentRequest.abort()
      this.currentRequest = undefined
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

    return new Promise((resolve) => {
      const url = new URL(`${baseUrl}/v1/codea/me`)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` }
        },
        (res) => {
          if (res.statusCode !== 200) {
            resolve(null)
            return
          }

          let data = ''
          res.on('data', (chunk) => (data += chunk))
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

    return new Promise((resolve) => {
      const url = new URL(`${baseUrl}/v1/models?category=coding`)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'GET'
        },
        (res) => {
          if (res.statusCode !== 200) {
            resolve([])
            return
          }

          let data = ''
          res.on('data', (chunk) => (data += chunk))
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
