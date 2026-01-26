/**
 * Alia Custom Provider for AI SDK
 * Routes AI SDK requests to Alia API /v1/chat/completions endpoint
 */

import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1StreamPart
} from 'ai'
import * as https from 'https'
import * as http from 'http'

interface AliaProviderOptions {
  apiKey: string
  baseUrl: string
}

class AliaLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1' as const
  readonly provider = 'alia' as const
  readonly modelId: string
  readonly defaultObjectGenerationMode = 'tool' as const

  private apiKey: string
  private baseUrl: string

  constructor(modelId: string, options: AliaProviderOptions) {
    this.modelId = modelId
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl
  }

  async doGenerate(options: LanguageModelV1CallOptions): Promise<any> {
    throw new Error('doGenerate not implemented - use doStream instead')
  }

  async doStream(
    options: LanguageModelV1CallOptions
  ): Promise<{ stream: ReadableStream<LanguageModelV1StreamPart> }> {
    const url = new URL(`${this.baseUrl}/v1/chat/completions`)
    const isHttps = url.protocol === 'https:'
    const httpModule = isHttps ? https : http

    // Convert AI SDK format to OpenAI format
    const messages = options.prompt.map(msg => {
      if (msg.role === 'system') {
        return { role: 'system', content: msg.content }
      } else if (msg.role === 'user') {
        return {
          role: 'user',
          content: msg.content
            .map(part => {
              if (part.type === 'text') return part.text
              return ''
            })
            .join('\n')
        }
      } else if (msg.role === 'assistant') {
        const content = msg.content
          .map(part => {
            if (part.type === 'text') return part.text
            return ''
          })
          .join('\n')

        const toolCalls = msg.content
          .filter(part => part.type === 'tool-call')
          .map((part: any) => ({
            id: part.toolCallId,
            type: 'function',
            function: {
              name: part.toolName,
              arguments: JSON.stringify(part.args)
            }
          }))

        if (toolCalls.length > 0) {
          return { role: 'assistant', content, tool_calls: toolCalls }
        }
        return { role: 'assistant', content }
      } else if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.content[0].toolCallId,
          content: msg.content[0].result
        }
      }
      return { role: 'user', content: '' }
    })

    // Convert AI SDK tools to OpenAI format
    const tools = options.tools?.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }))

    const postData = JSON.stringify({
      model: this.modelId,
      messages,
      tools,
      stream: true,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      frequency_penalty: options.frequencyPenalty,
      presence_penalty: options.presencePenalty
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
            'Content-Length': Buffer.byteLength(postData),
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
                reject(new Error(error.error || `HTTP ${res.statusCode}`))
              } catch {
                reject(new Error(`HTTP ${res.statusCode}`))
              }
            })
            return
          }

          const stream = new ReadableStream<LanguageModelV1StreamPart>({
            start(controller) {
              let buffer = ''

              res.on('data', (chunk: Buffer) => {
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

                    // Handle reasoning chunks
                    if (delta.reasoning) {
                      controller.enqueue({
                        type: 'text-delta',
                        textDelta: `<thinking>${delta.reasoning}</thinking>`
                      })
                    }

                    // Handle content
                    if (delta.content) {
                      controller.enqueue({
                        type: 'text-delta',
                        textDelta: delta.content
                      })
                    }

                    // Handle tool calls
                    if (delta.tool_calls) {
                      for (const toolCall of delta.tool_calls) {
                        if (toolCall.function?.name) {
                          const args = toolCall.function.arguments
                            ? JSON.parse(toolCall.function.arguments)
                            : {}

                          controller.enqueue({
                            type: 'tool-call',
                            toolCallType: 'function',
                            toolCallId: toolCall.id || `call_${Date.now()}`,
                            toolName: toolCall.function.name,
                            args
                          })
                        }
                      }
                    }

                    // Handle finish
                    if (json.choices?.[0]?.finish_reason) {
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
                            : 'unknown',
                        usage: {
                          promptTokens: json.usage?.prompt_tokens || 0,
                          completionTokens: json.usage?.completion_tokens || 0
                        }
                      })
                    }
                  } catch (error) {
                    console.error('[AliaProvider] Parse error:', error)
                  }
                }
              })

              res.on('end', () => {
                controller.close()
              })

              res.on('error', (error) => {
                controller.error(error)
              })
            }
          })

          resolve({ stream })
        }
      )

      req.on('error', reject)
      req.write(postData)
      req.end()
    })
  }
}

export function createAlia(options: AliaProviderOptions) {
  return (modelId: string): LanguageModelV1 => {
    return new AliaLanguageModel(modelId, options)
  }
}
