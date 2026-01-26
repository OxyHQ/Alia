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
    // If there are images, use multimodal format; otherwise use enhanced text
    if (context && context.length > 0 && context.some((item: any) => item.language === 'image')) {
      // Multimodal format for images
      const contentParts: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> = [
        { type: 'text', text: content }
      ]

      for (const item of context) {
        if (item.language === 'image') {
          contentParts.push({
            type: 'image_url',
            image_url: { url: item.content }
          })
        } else {
          contentParts[0].text += `\n\n**File: ${item.path}**\n\`\`\`${item.language || ''}\n${item.content}\n\`\`\``
        }
      }

      this.messages.push({ role: 'user', content: contentParts as any })
    } else if (context && context.length > 0) {
      // Text-only format
      let enhancedContent = content
      for (const item of context) {
        enhancedContent += `\n\n**File: ${item.path}**\n\`\`\`${item.language || ''}\n${item.content}\n\`\`\``
      }
      this.messages.push({ role: 'user', content: enhancedContent })
    } else {
      // No context
      this.messages.push({ role: 'user', content })
    }

    // Add system message if this is the first message
    if (this.messages.length === 1) {
      const systemMessage = await this.buildSystemMessage()
      this.messages.unshift({ role: 'system', content: systemMessage })
    }

    this.send('chat:start', {})

    try {
      console.log('[ChatProvider] ===== NEW MESSAGE =====')
      console.log('[ChatProvider] Mode:', mode)
      console.log('[ChatProvider] Model:', selectedModel)
      console.log('[ChatProvider] Base URL:', baseUrl)
      console.log('[ChatProvider] Tools enabled:', enableTools)
      console.log('[ChatProvider] Message count:', this.messages.length)

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
                description: 'List files and directories in a path. If no path provided, lists home directory.',
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'Directory path (default: home directory)' },
                    recursive: {
                      type: 'boolean',
                      description: 'List recursively'
                    }
                  }
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
                description: 'Take a screenshot of the screen and optionally save to a file path',
                parameters: {
                  type: 'object',
                  properties: {
                    path: {
                      type: 'string',
                      description: 'Optional file path to save the screenshot (e.g., ~/Desktop/screenshot.png, C:\\Users\\username\\Desktop\\screenshot.png)'
                    }
                  }
                }
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
            },
            {
              type: 'function',
              function: {
                name: 'list_installed_applications',
                description: 'List all installed applications on the system. Use this to find the correct name/path for apps before trying to open them.',
                parameters: {
                  type: 'object',
                  properties: {}
                }
              }
            }
          ]
        : undefined

      // Stream with OpenAI SDK
      console.log('[ChatProvider] Creating stream...')
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

      console.log('[ChatProvider] Stream created, processing chunks...')
      let assistantMessage = ''
      let toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
      let chunkCount = 0

      // Process stream chunks
      for await (const chunk of stream) {
        chunkCount++
        console.log(`[ChatProvider] Chunk ${chunkCount}:`, JSON.stringify(chunk, null, 2))
        const delta = chunk.choices?.[0]?.delta

        if (!delta) {
          console.log('[ChatProvider] Chunk has no delta, skipping')
          continue
        }

        // Handle reasoning (chain-of-thought)
        if ((delta as any).reasoning) {
          console.log('[ChatProvider] Reasoning chunk:', (delta as any).reasoning)
          this.send('chat:thinking', { content: (delta as any).reasoning })
        }

        // Handle content
        if (delta.content) {
          console.log('[ChatProvider] Content chunk:', delta.content)
          assistantMessage += delta.content
          this.send('chat:stream', { content: delta.content })
        }

        // Handle tool calls
        if (delta.tool_calls) {
          console.log('[ChatProvider] Tool call delta:', JSON.stringify(delta.tool_calls, null, 2))
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index ?? toolCalls.length
            console.log(`[ChatProvider] Processing tool call at index ${index}`)

            if (!toolCalls[index]) {
              console.log(`[ChatProvider] Creating new tool call at index ${index}`)
              toolCalls[index] = {
                id: toolCall.id || '',
                type: 'function',
                function: { name: toolCall.function?.name || '', arguments: '' }
              }
            }

            if (toolCall.function?.name) {
              console.log(`[ChatProvider] Setting tool name: ${toolCall.function.name}`)
              toolCalls[index].function.name = toolCall.function.name
            }

            if (toolCall.function?.arguments) {
              console.log(`[ChatProvider] Appending arguments: ${toolCall.function.arguments}`)
              toolCalls[index].function.arguments += toolCall.function.arguments
            }

            if (toolCall.id) {
              console.log(`[ChatProvider] Setting tool call ID: ${toolCall.id}`)
              toolCalls[index].id = toolCall.id
            }

            console.log(`[ChatProvider] Current tool call state at index ${index}:`, JSON.stringify(toolCalls[index], null, 2))
          }
        }

        // Handle finish reason
        if (chunk.choices?.[0]?.finish_reason) {
          console.log('[ChatProvider] Stream finished:', chunk.choices[0]?.finish_reason)
        }
      }

      console.log('[ChatProvider] Stream processing complete')
      console.log('[ChatProvider] Total chunks processed:', chunkCount)
      console.log('[ChatProvider] Assistant message length:', assistantMessage.length)
      console.log('[ChatProvider] Raw tool calls array:', JSON.stringify(toolCalls, null, 2))

      // Filter out undefined and incomplete tool calls before processing
      const validToolCalls = toolCalls.filter(tc => tc && tc.id && tc.function && tc.function.name)
      console.log('[ChatProvider] Valid tool calls after filtering:', validToolCalls.length)
      console.log('[ChatProvider] Valid tool calls:', JSON.stringify(validToolCalls, null, 2))

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
        console.log('[ChatProvider] ===== EXECUTING TOOLS =====')
        console.log('[ChatProvider] Number of tools to execute:', validToolCalls.length)

        for (const toolCall of validToolCalls) {
          console.log('[ChatProvider] Processing tool call:', JSON.stringify(toolCall, null, 2))

          if (!toolCall || !toolCall.function) {
            console.error('[ChatProvider] Invalid tool call:', toolCall)
            continue
          }

          const toolName = toolCall.function.name
          if (!toolName) {
            console.error('[ChatProvider] Tool call missing name:', toolCall)
            continue
          }

          console.log(`[ChatProvider] Executing tool: ${toolName}`)
          console.log(`[ChatProvider] Tool call ID: ${toolCall.id}`)
          console.log(`[ChatProvider] Raw arguments: ${toolCall.function.arguments}`)

          let args: any = {}
          try {
            args = JSON.parse(toolCall.function.arguments || '{}')
            console.log('[ChatProvider] Parsed arguments:', JSON.stringify(args, null, 2))
          } catch (e) {
            console.error('[ChatProvider] Failed to parse tool arguments:', toolCall.function.arguments, e)
            continue
          }

          // Handle set_mode specially
          if (toolName === 'set_mode') {
            console.log(`[ChatProvider] Setting mode to: ${args.mode}`)
            this.currentMode = args.mode
            this.send('chat:modeChanged', { mode: this.currentMode })
          }

          this.send('chat:tool', {
            tool: toolName,
            args,
            status: 'running'
          })

          try {
            console.log(`[ChatProvider] Calling tool executor for: ${toolName}`)
            // Execute tool locally
            let result: string
            switch (toolName) {
              case 'read_file':
                console.log('[ChatProvider] Executing read_file')
                result = await this.toolExecutor.readFile(args)
                break
              case 'write_file':
                console.log('[ChatProvider] Executing write_file')
                result = await this.toolExecutor.writeFile(args)
                break
              case 'edit_file':
                console.log('[ChatProvider] Executing edit_file')
                result = await this.toolExecutor.editFile(args)
                break
              case 'list_files':
                console.log('[ChatProvider] Executing list_files')
                result = await this.toolExecutor.listFiles(args)
                break
              case 'search_files':
                console.log('[ChatProvider] Executing search_files')
                result = await this.toolExecutor.searchFiles(args)
                break
              case 'run_command':
                console.log('[ChatProvider] Executing run_command')
                result = await this.toolExecutor.runCommand(args)
                break
              case 'open_application':
                console.log('[ChatProvider] Executing open_application')
                result = await this.toolExecutor.openApplication(args)
                break
              case 'open_url':
                console.log('[ChatProvider] Executing open_url')
                result = await this.toolExecutor.openUrl(args)
                break
              case 'clipboard_read':
                console.log('[ChatProvider] Executing clipboard_read')
                result = this.toolExecutor.clipboardRead()
                break
              case 'clipboard_write':
                console.log('[ChatProvider] Executing clipboard_write')
                result = this.toolExecutor.clipboardWrite(args)
                break
              case 'get_system_info':
                console.log('[ChatProvider] Executing get_system_info')
                result = this.toolExecutor.getSystemInfo()
                break
              case 'screenshot':
                console.log('[ChatProvider] Executing screenshot')
                result = await this.toolExecutor.screenshot()
                break
              case 'set_mode':
                console.log('[ChatProvider] Executing set_mode')
                result = `Mode changed to ${args.mode}`
                break
              case 'list_installed_applications':
                console.log('[ChatProvider] Executing list_installed_applications')
                result = await this.toolExecutor.listInstalledApplications()
                break
              default:
                console.error(`[ChatProvider] Unknown tool: ${toolName}`)
                result = `Unknown tool: ${toolName}`
            }

            console.log(`[ChatProvider] Tool ${toolName} executed successfully`)
            console.log(`[ChatProvider] Result length: ${String(result || '').length}`)
            console.log(`[ChatProvider] Result preview: ${String(result || '').slice(0, 200)}`)

            // Add tool result to messages
            // Append reminder to tool result to prevent redundant calls
            let toolResult = result
            if (result.includes('already open') || result.includes('DO NOT call')) {
              console.log('[ChatProvider] Adding reminder to tool result to prevent redundant tool calls')
              toolResult += '\n\n[SYSTEM REMINDER: The action is complete. Do NOT call the same tool again. Move to the next task or provide your final response.]'
            }

            this.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResult
            })
            console.log(`[ChatProvider] Added tool result to messages (total: ${this.messages.length})`)

            this.send('chat:toolResult', {
              tool: toolName,
              success: true,
              result: String(toolResult || '').slice(0, 500)
            })
          } catch (error: any) {
            const errorMsg = error.message || String(error)
            console.error(`[ChatProvider] Tool ${toolName} execution failed:`, errorMsg)
            console.error('[ChatProvider] Error stack:', error.stack)

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

        console.log('[ChatProvider] All tools executed, continuing with tool results...')
        console.log('[ChatProvider] Current message history:', JSON.stringify(this.messages.map(m => ({ role: m.role, hasContent: !!m.content })), null, 2))

        // Continue conversation with tool results - recursively call handleMessage
        // but without adding a new user message
        await this.continueWithToolResults(openai, selectedModel, tools)
      }

      console.log('[ChatProvider] Chat session complete')
      this.send('chat:end', {})
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('[ChatProvider] Stream aborted by user')
        this.send('chat:end', {})
      } else {
        console.error('[ChatProvider] ===== STREAM ERROR =====')
        console.error('[ChatProvider] Error name:', error.name)
        console.error('[ChatProvider] Error message:', error.message)
        console.error('[ChatProvider] Error stack:', error.stack)
        console.error('[ChatProvider] Full error:', JSON.stringify(error, null, 2))
        this.send('chat:error', { message: this.formatErrorMessage(error) })
      }
    } finally {
      console.log('[ChatProvider] ===== SESSION END =====')
      console.log('[ChatProvider] Final message count:', this.messages.length)
      this.isProcessing = false
      this.abortController = undefined
    }
  }

  private async continueWithToolResults(
    openai: OpenAI,
    model: string,
    tools: OpenAI.Chat.ChatCompletionTool[] | undefined,
    iterationCount: number = 0
  ): Promise<void> {
    // Prevent infinite loops
    const MAX_ITERATIONS = 3
    if (iterationCount >= MAX_ITERATIONS) {
      console.warn(`[ChatProvider] Max iterations (${MAX_ITERATIONS}) reached, forcing final response`)
      // Force final response without more tool calls
      const stream = await openai.chat.completions.create(
        {
          model,
          messages: this.messages,
          tool_choice: 'none', // Force response without tools
          stream: true,
          temperature: 0.7,
          max_tokens: 4096
        },
        {
          signal: this.abortController?.signal
        }
      )

      let finalMessage = ''
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta
        if (delta?.content) {
          finalMessage += delta.content
          this.send('chat:stream', { content: delta.content })
        }
      }

      if (finalMessage) {
        this.messages.push({
          role: 'assistant',
          content: finalMessage
        })
      }
      return
    }

    console.log('[ChatProvider] ===== CONTINUING WITH TOOL RESULTS =====')
    console.log('[ChatProvider] Iteration:', iterationCount + 1)
    console.log('[ChatProvider] Current message count:', this.messages.length)
    console.log('[ChatProvider] Last 3 messages:', JSON.stringify(this.messages.slice(-3).map(m => ({
      role: m.role,
      contentLength: typeof m.content === 'string' ? m.content.length : 0,
      hasToolCalls: !!(m as any).tool_calls
    })), null, 2))

    try {
      // Stream continuation with tool results
      console.log('[ChatProvider] Creating continuation stream...')

      // After first iteration, prefer not calling more tools unless absolutely necessary
      const streamConfig: any = {
        model,
        messages: this.messages,
        tools,
        stream: true,
        temperature: 0.7,
        max_tokens: 4096
      }

      // After iteration 1, discourage more tool calls
      if (iterationCount >= 1) {
        streamConfig.tool_choice = 'auto' // Let model decide, but with penalty
        console.log('[ChatProvider] Iteration >= 1, model should prefer responding')
      }

      const stream = await openai.chat.completions.create(
        streamConfig,
        {
          signal: this.abortController?.signal
        }
      )

      console.log('[ChatProvider] Continuation stream created, processing chunks...')
      let assistantMessage = ''
      let toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
      let contChunkCount = 0

      // Process stream chunks
      for await (const chunk of stream) {
        contChunkCount++
        console.log(`[ChatProvider] Continuation chunk ${contChunkCount}:`, JSON.stringify(chunk, null, 2))

        const delta = chunk.choices?.[0]?.delta

        if (!delta) {
          console.log('[ChatProvider] Continuation chunk has no delta, skipping')
          continue
        }

        // Handle reasoning
        if ((delta as any).reasoning) {
          console.log('[ChatProvider] Continuation reasoning chunk:', (delta as any).reasoning)
          this.send('chat:thinking', { content: (delta as any).reasoning })
        }

        // Handle content
        if (delta.content) {
          console.log('[ChatProvider] Continuation content chunk:', delta.content)
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

      // Filter out undefined and incomplete tool calls before processing
      const validToolCalls = toolCalls.filter(tc => tc && tc.id && tc.function && tc.function.name)

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
          if (!toolCall || !toolCall.function) {
            console.error('[ChatProvider] Invalid tool call in continuation:', toolCall)
            continue
          }

          const toolName = toolCall.function.name
          if (!toolName) {
            console.error('[ChatProvider] Tool call missing name in continuation:', toolCall)
            continue
          }

          let args: any = {}
          try {
            args = JSON.parse(toolCall.function.arguments || '{}')
          } catch (e) {
            console.error('[ChatProvider] Failed to parse tool arguments in continuation:', toolCall.function.arguments, e)
            continue
          }

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
              case 'list_installed_applications':
                result = await this.toolExecutor.listInstalledApplications()
                break
              default:
                result = `Unknown tool: ${toolName}`
            }

            // Append reminder to tool result to prevent redundant calls
            let toolResult = result
            if (result.includes('already open') || result.includes('DO NOT call')) {
              console.log('[ChatProvider] Adding reminder to tool result in continuation to prevent redundant tool calls')
              toolResult += '\n\n[SYSTEM REMINDER: The action is complete. Do NOT call the same tool again. Move to the next task or provide your final response.]'
            }

            this.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResult
            })

            this.send('chat:toolResult', {
              tool: toolName,
              success: true,
              result: String(toolResult || '').slice(0, 500)
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

        console.log('[ChatProvider] More tools to execute, continuing recursively...')
        // Continue recursively with incremented iteration count
        await this.continueWithToolResults(openai, model, tools, iterationCount + 1)
      } else {
        console.log('[ChatProvider] No more tools to execute, continuation complete')
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error('[ChatProvider] ===== CONTINUATION ERROR =====')
        console.error('[ChatProvider] Error name:', error.name)
        console.error('[ChatProvider] Error message:', error.message)
        console.error('[ChatProvider] Error stack:', error.stack)
        console.error('[ChatProvider] Full error:', JSON.stringify(error, null, 2))
      } else {
        console.log('[ChatProvider] Continuation aborted by user')
      }
    }
  }

  private async buildSystemMessage(): Promise<string> {
    // Minimal client context - let backend handle all instructions
    // Backend will add language rules, tool usage instructions, user memory, etc.

    const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'

    let systemMessage = `Client: Alia Cowork Desktop (${platform})
- **clipboard_read/write**: Access clipboard
- **get_system_info**: Get detailed system information
- **screenshot**: Capture the entire screen
- **set_mode**: Change operating mode (ask/edit/plan/yolo)

### Server Tools (Execute on Alia servers - do NOT use open_application for these)
- **getCurrentDate**: Get current date and time
- **sendTelegram**: Send message DIRECTLY to user's Telegram via bot API
  - USE THIS to send Telegram messages - you CAN and SHOULD use it
  - When user says "send me X on Telegram", "remind me via Telegram", "envíame un telegram"
  - Do NOT use open_application for Telegram - use this tool instead
  - Sends message directly via bot without opening the app
  - Example: User asks "envíame eso en Telegram" → Use sendTelegram tool with the message
- **saveUserMemory**: Save important user information for future conversations
  - USE THIS when user shares: preferences, personal info, goals, experiences
  - Examples: favorite things, occupation, pets, etc.
- **updateUserPreferences**: Update user communication preferences
  - Language, tone, response length, interests
- **updateUserContext**: Update user context information
  - Occupation, location, timezone, bio`

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
    this.toolExecutor.reset()
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

  async getUserMemory(): Promise<any> {
    const apiKey = store.get('apiKey') as string
    const baseUrl = store.get('apiBaseUrl') as string

    if (!apiKey) return null

    try {
      const response = await fetch(`${baseUrl}/memory`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      })

      if (!response.ok) return null

      return await response.json()
    } catch {
      return null
    }
  }
}
