/**
 * Alia Custom Provider for AI SDK 6
 * Implements LanguageModelV3 to route requests to our API
 */

import * as https from 'https'
import * as http from 'http'

interface AliaProviderOptions {
  apiKey: string
  baseUrl: string
}

class AliaLanguageModel {
  readonly specificationVersion = 'v3' as const
  readonly provider = 'alia' as const
  readonly modelId: string
  readonly supportedUrls = {}

  private apiKey: string
  private baseUrl: string

  constructor(modelId: string, options: AliaProviderOptions) {
    this.modelId = modelId
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl
  }

  async doGenerate(): Promise<any> {
    throw new Error('doGenerate not implemented - use doStream instead')
  }

  async doStream(options: any): Promise<any> {
    const url = new URL(`${this.baseUrl}/v1/chat/completions`)
    const isHttps = url.protocol === 'https:'
    const httpModule = isHttps ? https : http

    // Convert AI SDK messages to OpenAI format
    const messages: any[] = []

    for (const msg of options.prompt) {
      if (msg.role === 'system') {
        messages.push({ role: 'system', content: msg.content })
      } else if (msg.role === 'user') {
        const content = msg.content
          .map((part: any) => {
            if (part.type === 'text') return part.text
            return ''
          })
          .join('\n')
        messages.push({ role: 'user', content })
      } else if (msg.role === 'assistant') {
        const content = msg.content
          .map((part: any) => {
            if (part.type === 'text') return part.text
            return ''
          })
          .join('\n')

        const toolCalls = msg.content
          .filter((part: any) => part.type === 'tool-call')
          .map((part: any) => ({
            id: part.toolCallId,
            type: 'function',
            function: {
              name: part.toolName,
              arguments: JSON.stringify(part.args || {})
            }
          }))

        if (toolCalls.length > 0) {
          messages.push({ role: 'assistant', content, tool_calls: toolCalls })
        } else {
          messages.push({ role: 'assistant', content })
        }
      } else if (msg.role === 'tool') {
        for (const part of msg.content) {
          if (part.type === 'tool-result') {
            messages.push({
              role: 'tool',
              tool_call_id: part.toolCallId,
              content: typeof part.output === 'string' ? part.output : JSON.stringify(part.output)
            })
          }
        }
      }
    }

    // Convert AI SDK tools to OpenAI format
    const openaiTools = options.tools?.map((tool: any) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }))

    const requestBody = JSON.stringify({
      model: this.modelId,
      messages,
      tools: openaiTools,
      stream: true,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxOutputTokens ?? 4096
    })

    return new Promise((resolve, reject) => {
      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody),
            Authorization: `Bearer ${this.apiKey}`
          }
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errorData = ''
            res.on('data', (chunk) => (errorData += chunk))
            res.on('end', () => {
              try {
                const error = JSON.parse(errorData)
                reject(new Error(error.error?.message || `HTTP ${res.statusCode}`))
              } catch {
                reject(new Error(`HTTP ${res.statusCode}`))
              }
            })
            return
          }

          const stream = new ReadableStream({
            start(controller) {
              let buffer = ''
              let isFirstChunk = true
              let isClosed = false

              const closeController = () => {
                if (!isClosed) {
                  isClosed = true
                  try {
                    controller.close()
                  } catch (e) {
                    // Controller already closed, ignore
                  }
                }
              }

              res.on('data', (chunk: Buffer) => {
                if (isClosed) return

                buffer += chunk.toString()
                const lines = buffer.split('\n')
                buffer = lines.pop() || ''

                for (const line of lines) {
                  if (isClosed) break

                  if (!line.trim()) continue
                  if (line.trim() === 'data: [DONE]') {
                    closeController()
                    break
                  }
                  if (!line.startsWith('data: ')) continue

                  try {
                    const json = JSON.parse(line.slice(6))
                    const delta = json.choices?.[0]?.delta

                    if (!delta && !json.choices?.[0]?.finish_reason) continue

                    // Send stream-start event
                    if (isFirstChunk && !isClosed) {
                      controller.enqueue({
                        type: 'stream-start',
                        warnings: []
                      })
                      isFirstChunk = false
                    }

                    // Handle reasoning chunks
                    if (delta?.reasoning && !isClosed) {
                      controller.enqueue({
                        type: 'text',
                        id: `chunk_${Date.now()}`,
                        text: `<thinking>${delta.reasoning}</thinking>`
                      })
                    }

                    // Handle content
                    if (delta?.content && !isClosed) {
                      controller.enqueue({
                        type: 'text',
                        id: `chunk_${Date.now()}`,
                        text: delta.content
                      })
                    }

                    // Handle tool calls
                    if (delta?.tool_calls && !isClosed) {
                      for (const toolCall of delta.tool_calls) {
                        if (isClosed) break
                        if (toolCall.function?.name && toolCall.function?.arguments) {
                          try {
                            const args = JSON.parse(toolCall.function.arguments)
                            controller.enqueue({
                              type: 'tool-call',
                              toolCallType: 'function',
                              toolCallId: toolCall.id || `call_${Date.now()}`,
                              toolName: toolCall.function.name,
                              input: args
                            })
                          } catch (e) {
                            console.error('[AliaProvider] Failed to parse tool args:', e)
                          }
                        }
                      }
                    }

                    // Handle finish - must be last
                    if (json.choices?.[0]?.finish_reason && !isClosed) {
                      const finishReason = json.choices[0].finish_reason
                      controller.enqueue({
                        type: 'finish',
                        finishReason:
                          finishReason === 'stop'
                            ? 'stop'
                            : finishReason === 'length'
                            ? 'length'
                            : finishReason === 'tool_calls'
                            ? 'tool-calls'
                            : 'other',
                        usage: {
                          inputTokens: json.usage?.prompt_tokens || 0,
                          outputTokens: json.usage?.completion_tokens || 0
                        }
                      })
                      closeController()
                      break
                    }
                  } catch (error) {
                    console.error('[AliaProvider] Parse error:', error)
                  }
                }
              })

              res.on('end', () => {
                closeController()
              })

              res.on('error', (error) => {
                if (!isClosed) {
                  isClosed = true
                  controller.error(error)
                }
              })
            }
          })

          resolve({ stream, warnings: [] })
        }
      )

      req.on('error', reject)
      req.write(requestBody)
      req.end()
    })
  }
}

export function createAlia(options: AliaProviderOptions) {
  const createModel = (modelId: string) => new AliaLanguageModel(modelId, options)

  const provider = function (modelId: string) {
    return createModel(modelId)
  }

  provider.languageModel = createModel

  return provider
}
