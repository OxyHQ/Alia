/**
 * Alia Custom Provider for AI SDK 6
 * Uses customProvider to create a provider that routes to our API
 */

import { customProvider } from 'ai'
import * as https from 'https'
import * as http from 'http'

interface AliaProviderOptions {
  apiKey: string
  baseUrl: string
}

export function createAlia(options: AliaProviderOptions) {
  return customProvider({
    languageModels: {
      'alia-v1-cowork': async ({ prompt, tools, ...settings }) => {
        const url = new URL(`${options.baseUrl}/v1/chat/completions`)
        const isHttps = url.protocol === 'https:'
        const httpModule = isHttps ? https : http

        // Convert AI SDK messages to OpenAI format
        const messages: any[] = []

        for (const msg of prompt) {
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
                  content: typeof part.result === 'string' ? part.result : JSON.stringify(part.result)
                })
              }
            }
          }
        }

        // Convert AI SDK tools to OpenAI format
        const openaiTools = tools?.map((tool: any) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        }))

        const requestBody = JSON.stringify({
          model: 'alia-v1-cowork',
          messages,
          tools: openaiTools,
          stream: true,
          temperature: settings.temperature ?? 0.7,
          max_tokens: settings.maxTokens ?? 4096
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
                Authorization: `Bearer ${options.apiKey}`
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
                            if (toolCall.function?.name && toolCall.function?.arguments) {
                              try {
                                const args = JSON.parse(toolCall.function.arguments)
                                controller.enqueue({
                                  type: 'tool-call',
                                  toolCallType: 'function',
                                  toolCallId: toolCall.id || `call_${Date.now()}`,
                                  toolName: toolCall.function.name,
                                  args
                                })
                              } catch (e) {
                                console.error('[AliaProvider] Failed to parse tool args:', e)
                              }
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
          req.write(requestBody)
          req.end()
        })
      }
    }
  })
}
