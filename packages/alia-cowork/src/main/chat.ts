/**
 * Chat Provider using OpenAI SDK
 * Streams responses using OpenAI SDK directly to Alia API
 */

import { BrowserWindow } from 'electron'
import OpenAI from 'openai'
import { ToolExecutor } from './tools'
import Store from 'electron-store'
import { errorMessage, errorName, errorStack } from './errors'
import { createLogger } from './logger'

/** A file/folder context item attached to a chat message from the renderer. */
interface ContextItem {
  type: 'file' | 'folder'
  path: string
  content?: string
  language?: string
}

/** OpenAI streaming delta may carry a non-standard `reasoning` field on the Alia gateway. */
type ReasoningDelta = OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning?: string }

const logger = createLogger('ChatProvider')

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
  private browserUsedInCurrentTurn = false

  constructor(window: BrowserWindow, toolExecutor: ToolExecutor) {
    this.window = window
    this.toolExecutor = toolExecutor
  }

  private send(channel: string, data: unknown): void {
    this.window.webContents.send(channel, data)
  }

  async handleMessage(
    content: string,
    mode: string = 'ask',
    model?: string,
    context?: ContextItem[]
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
    this.browserUsedInCurrentTurn = false

    // Build user message with context
    // Separate folders from files
    const folders = context?.filter((item) => item.type === 'folder') || []
    const files = context?.filter((item) => item.type === 'file') || []
    const hasImages = files.some((item) => item.language === 'image')

    if (hasImages) {
      // Multimodal format for images
      const textPart: OpenAI.Chat.ChatCompletionContentPartText = { type: 'text', text: content }
      const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [textPart]

      // Add folder references (just mention the path)
      if (folders.length > 0) {
        textPart.text += '\n\n**Attached Folders** (use list_files and read_file tools to explore):'
        for (const folder of folders) {
          textPart.text += `\n- ${folder.path}`
        }
      }

      // Add files
      for (const item of files) {
        if (item.language === 'image') {
          contentParts.push({
            type: 'image_url',
            image_url: { url: item.content ?? '' }
          })
        } else {
          textPart.text += `\n\n**File: ${item.path}**\n\`\`\`${item.language || ''}\n${item.content}\n\`\`\``
        }
      }

      this.messages.push({ role: 'user', content: contentParts })
    } else if (context && context.length > 0) {
      // Text-only format
      let enhancedContent = content

      // Add folder references
      if (folders.length > 0) {
        enhancedContent += '\n\n**Attached Folders** (use list_files and read_file tools to explore):'
        for (const folder of folders) {
          enhancedContent += `\n- ${folder.path}`
        }
      }

      // Add files
      for (const item of files) {
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
      logger.debug('===== NEW MESSAGE =====')
      logger.debug('Mode:', mode)
      logger.debug('Model:', selectedModel)
      logger.debug('Base URL:', baseUrl)
      logger.debug('Tools enabled:', enableTools)
      logger.debug('Message count:', this.messages.length)

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
                description: 'DEPRECATED: Open a URL in external system browser. DO NOT USE THIS - use browser_action instead for all web navigation. Only use this if user explicitly asks to open in external browser.',
                parameters: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', description: 'URL to open in external browser' }
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
            },
            {
              type: 'function',
              function: {
                name: 'browser_action',
                description: 'PRIMARY TOOL FOR WEB NAVIGATION: Navigate to websites, interact with pages, extract data using AI-powered browser automation. Automatically switches to browser tab with live preview. Use this for ALL web browsing tasks (opening URLs, searching, filling forms, clicking, extracting data, etc).',
                parameters: {
                  type: 'object',
                  properties: {
                    url: {
                      type: 'string',
                      description: 'URL to navigate to'
                    },
                    action: {
                      type: 'string',
                      description: 'Natural language description of the action to perform (e.g., "click on login button", "fill the search box with AI", "scroll down to the footer")'
                    },
                    extract: {
                      type: 'string',
                      description: 'Natural language description of data to extract from the page (e.g., "the price of the first product", "all article titles", "the contact email")'
                    }
                  }
                }
              }
            },
            {
              type: 'function',
              function: {
                name: 'close_browser',
                description: 'Close the browser tab and return to chat',
                parameters: {
                  type: 'object',
                  properties: {}
                }
              }
            }
          ]
        : undefined

      // Stream with OpenAI SDK
      logger.debug('Creating stream...')
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

      logger.debug('Stream created, processing chunks...')
      let assistantMessage = ''
      let toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
      let chunkCount = 0

      // Process stream chunks
      for await (const chunk of stream) {
        chunkCount++
        logger.debug(`Chunk ${chunkCount}:`, JSON.stringify(chunk, null, 2))
        const delta = chunk.choices?.[0]?.delta

        if (!delta) {
          logger.debug('Chunk has no delta, skipping')
          continue
        }

        // Handle reasoning (chain-of-thought)
        if ((delta as ReasoningDelta).reasoning) {
          logger.debug('Reasoning chunk:', (delta as ReasoningDelta).reasoning)
          this.send('chat:thinking', { content: (delta as ReasoningDelta).reasoning })
        }

        // Handle content
        if (delta.content) {
          logger.debug('Content chunk:', delta.content)
          assistantMessage += delta.content
          this.send('chat:stream', { content: delta.content })
        }

        // Handle tool calls
        if (delta.tool_calls) {
          logger.debug('Tool call delta:', JSON.stringify(delta.tool_calls, null, 2))
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index ?? toolCalls.length
            logger.debug(`Processing tool call at index ${index}`)

            if (!toolCalls[index]) {
              logger.debug(`Creating new tool call at index ${index}`)
              toolCalls[index] = {
                id: toolCall.id || '',
                type: 'function',
                function: { name: toolCall.function?.name || '', arguments: '' }
              }
            }

            if (toolCall.function?.name) {
              logger.debug(`Setting tool name: ${toolCall.function.name}`)
              toolCalls[index].function.name = toolCall.function.name
            }

            if (toolCall.function?.arguments) {
              logger.debug(`Appending arguments: ${toolCall.function.arguments}`)
              toolCalls[index].function.arguments += toolCall.function.arguments
            }

            if (toolCall.id) {
              logger.debug(`Setting tool call ID: ${toolCall.id}`)
              toolCalls[index].id = toolCall.id
            }

            logger.debug(`Current tool call state at index ${index}:`, JSON.stringify(toolCalls[index], null, 2))
          }
        }

        // Handle finish reason
        if (chunk.choices?.[0]?.finish_reason) {
          logger.debug('Stream finished:', chunk.choices[0]?.finish_reason)
        }
      }

      logger.debug('Stream processing complete')
      logger.debug('Total chunks processed:', chunkCount)
      logger.debug('Assistant message length:', assistantMessage.length)
      logger.debug('Raw tool calls array:', JSON.stringify(toolCalls, null, 2))

      // Filter out undefined and incomplete tool calls before processing
      const validToolCalls = toolCalls.filter(tc => tc && tc.id && tc.function && tc.function.name)
      logger.debug('Valid tool calls after filtering:', validToolCalls.length)
      logger.debug('Valid tool calls:', JSON.stringify(validToolCalls, null, 2))

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
        logger.debug('===== EXECUTING TOOLS =====')
        logger.debug('Number of tools to execute:', validToolCalls.length)

        for (const toolCall of validToolCalls) {
          logger.debug('Processing tool call:', JSON.stringify(toolCall, null, 2))

          if (!toolCall || !toolCall.function) {
            logger.error('Invalid tool call:', toolCall)
            continue
          }

          const toolName = toolCall.function.name
          if (!toolName) {
            logger.error('Tool call missing name:', toolCall)
            continue
          }

          logger.debug(`Executing tool: ${toolName}`)
          logger.debug(`Tool call ID: ${toolCall.id}`)
          logger.debug(`Raw arguments: ${toolCall.function.arguments}`)

          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(toolCall.function.arguments || '{}')
            logger.debug('Parsed arguments:', JSON.stringify(args, null, 2))
          } catch (e) {
            logger.error('Failed to parse tool arguments:', toolCall.function.arguments, e)
            continue
          }

          // Handle set_mode specially
          if (toolName === 'set_mode') {
            logger.debug(`Setting mode to: ${args.mode}`)
            this.currentMode = String(args.mode ?? this.currentMode)
            this.send('chat:modeChanged', { mode: this.currentMode })
          }

          this.send('chat:tool', {
            tool: toolName,
            args,
            status: 'running'
          })

          try {
            logger.debug(`Calling tool executor for: ${toolName}`)
            // Execute tool locally
            let result: string
            switch (toolName) {
              case 'read_file':
                logger.debug('Executing read_file')
                result = await this.toolExecutor.readFile(args as { path: string; start_line?: number; end_line?: number })
                break
              case 'write_file':
                logger.debug('Executing write_file')
                result = await this.toolExecutor.writeFile(args as { path: string; content: string })
                break
              case 'edit_file':
                logger.debug('Executing edit_file')
                result = await this.toolExecutor.editFile(args as { path: string; old_text: string; new_text: string })
                break
              case 'list_files':
                logger.debug('Executing list_files')
                result = await this.toolExecutor.listFiles(args as { path?: string; recursive?: boolean })
                break
              case 'search_files':
                logger.debug('Executing search_files')
                result = await this.toolExecutor.searchFiles(args as { pattern: string; path?: string })
                break
              case 'run_command':
                logger.debug('Executing run_command')
                result = await this.toolExecutor.runCommand(args as { command: string; cwd?: string })
                break
              case 'open_application':
                logger.debug('Executing open_application')
                result = await this.toolExecutor.openApplication(args as { application_name: string })
                break
              case 'open_url':
                logger.debug('Executing open_url')
                result = await this.toolExecutor.openUrl(args as { url: string })
                break
              case 'clipboard_read':
                logger.debug('Executing clipboard_read')
                result = this.toolExecutor.clipboardRead()
                break
              case 'clipboard_write':
                logger.debug('Executing clipboard_write')
                result = this.toolExecutor.clipboardWrite(args as { text: string })
                break
              case 'get_system_info':
                logger.debug('Executing get_system_info')
                result = this.toolExecutor.getSystemInfo()
                break
              case 'screenshot':
                logger.debug('Executing screenshot')
                result = await this.toolExecutor.screenshot()
                break
              case 'set_mode':
                logger.debug('Executing set_mode')
                result = `Mode changed to ${args.mode}`
                break
              case 'list_installed_applications':
                logger.debug('Executing list_installed_applications')
                result = await this.toolExecutor.listInstalledApplications()
                break
              case 'browser_action':
                logger.debug('Executing browser_action')
                this.browserUsedInCurrentTurn = true
                result = await this.toolExecutor.browserAction(args)
                break
              case 'close_browser':
                logger.debug('Executing close_browser')
                result = await this.toolExecutor.closeBrowser()
                break
              default:
                logger.error(`Unknown tool: ${toolName}`)
                result = `Unknown tool: ${toolName}`
            }

            logger.debug(`Tool ${toolName} executed successfully`)
            logger.debug(`Result length: ${String(result || '').length}`)
            logger.debug(`Result preview: ${String(result || '').slice(0, 200)}`)

            // Add tool result to messages
            // Append reminder to tool result to prevent redundant calls
            let toolResult = result
            if (result.includes('already open') || result.includes('DO NOT call')) {
              logger.debug('Adding reminder to tool result to prevent redundant tool calls')
              toolResult += '\n\n[SYSTEM REMINDER: The action is complete. Do NOT call the same tool again. Move to the next task or provide your final response.]'
            }

            this.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResult
            })
            logger.debug(`Added tool result to messages (total: ${this.messages.length})`)

            this.send('chat:toolResult', {
              tool: toolName,
              success: true,
              result: String(toolResult || '').slice(0, 500)
            })
          } catch (error: unknown) {
            const errorMsg = errorMessage(error)
            logger.error(`Tool ${toolName} execution failed:`, errorMsg)
            logger.error('Error stack:', errorStack(error))

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

        logger.debug('All tools executed, continuing with tool results...')
        logger.debug('Current message history:', JSON.stringify(this.messages.map(m => ({ role: m.role, hasContent: !!m.content })), null, 2))

        // Continue conversation with tool results - recursively call handleMessage
        // but without adding a new user message
        await this.continueWithToolResults(openai, selectedModel, tools)
      }

      logger.debug('Chat session complete')
      this.send('chat:end', {})

      // Auto-close browser if it was used in this turn
      if (this.browserUsedInCurrentTurn) {
        logger.debug('Browser was used, auto-closing and returning to chat...')
        try {
          await this.toolExecutor.closeBrowser()
        } catch (error) {
          logger.error('Error auto-closing browser:', error)
        }
      }
    } catch (error: unknown) {
      if (errorName(error) === 'AbortError') {
        logger.debug('Stream aborted by user')
        this.send('chat:end', {})
      } else {
        logger.error('===== STREAM ERROR =====')
        logger.error('Error name:', errorName(error))
        logger.error('Error message:', errorMessage(error))
        logger.error('Error stack:', errorStack(error))
        logger.error('Full error:', JSON.stringify(error, null, 2))
        this.send('chat:error', { message: this.formatErrorMessage(error) })
      }
    } finally {
      logger.debug('===== SESSION END =====')
      logger.debug('Final message count:', this.messages.length)
      this.isProcessing = false
      this.abortController = undefined
      this.browserUsedInCurrentTurn = false
    }
  }

  private async continueWithToolResults(
    openai: OpenAI,
    model: string,
    tools: OpenAI.Chat.ChatCompletionTool[] | undefined,
    iterationCount: number = 0
  ): Promise<void> {
    // Prevent infinite loops
    const MAX_ITERATIONS = 5
    if (iterationCount >= MAX_ITERATIONS) {
      logger.warn(`Max iterations (${MAX_ITERATIONS}) reached, forcing final response`)
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

    logger.debug('===== CONTINUING WITH TOOL RESULTS =====')
    logger.debug('Iteration:', iterationCount + 1)
    logger.debug('Current message count:', this.messages.length)
    logger.debug('Last 3 messages:', JSON.stringify(this.messages.slice(-3).map(m => ({
      role: m.role,
      contentLength: typeof m.content === 'string' ? m.content.length : 0,
      hasToolCalls: !!(m as OpenAI.Chat.ChatCompletionAssistantMessageParam).tool_calls
    })), null, 2))

    try {
      // Stream continuation with tool results
      logger.debug('Creating continuation stream...')

      // After first iteration, prefer not calling more tools unless absolutely necessary
      const streamConfig: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
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
        logger.debug('Iteration >= 1, model should prefer responding')
      }

      const stream = await openai.chat.completions.create(
        streamConfig,
        {
          signal: this.abortController?.signal
        }
      ) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

      logger.debug('Continuation stream created, processing chunks...')
      let assistantMessage = ''
      let toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
      let contChunkCount = 0

      // Process stream chunks
      for await (const chunk of stream) {
        contChunkCount++
        logger.debug(`Continuation chunk ${contChunkCount}:`, JSON.stringify(chunk, null, 2))

        const delta = chunk.choices?.[0]?.delta

        if (!delta) {
          logger.debug('Continuation chunk has no delta, skipping')
          continue
        }

        // Handle reasoning
        if ((delta as ReasoningDelta).reasoning) {
          logger.debug('Continuation reasoning chunk:', (delta as ReasoningDelta).reasoning)
          this.send('chat:thinking', { content: (delta as ReasoningDelta).reasoning })
        }

        // Handle content
        if (delta.content) {
          logger.debug('Continuation content chunk:', delta.content)
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
            logger.error('Invalid tool call in continuation:', toolCall)
            continue
          }

          const toolName = toolCall.function.name
          if (!toolName) {
            logger.error('Tool call missing name in continuation:', toolCall)
            continue
          }

          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(toolCall.function.arguments || '{}')
          } catch (e) {
            logger.error('Failed to parse tool arguments in continuation:', toolCall.function.arguments, e)
            continue
          }

          if (toolName === 'set_mode') {
            this.currentMode = String(args.mode ?? this.currentMode)
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
                result = await this.toolExecutor.readFile(args as { path: string; start_line?: number; end_line?: number })
                break
              case 'write_file':
                result = await this.toolExecutor.writeFile(args as { path: string; content: string })
                break
              case 'edit_file':
                result = await this.toolExecutor.editFile(args as { path: string; old_text: string; new_text: string })
                break
              case 'list_files':
                result = await this.toolExecutor.listFiles(args as { path?: string; recursive?: boolean })
                break
              case 'search_files':
                result = await this.toolExecutor.searchFiles(args as { pattern: string; path?: string })
                break
              case 'run_command':
                result = await this.toolExecutor.runCommand(args as { command: string; cwd?: string })
                break
              case 'open_application':
                result = await this.toolExecutor.openApplication(args as { application_name: string })
                break
              case 'open_url':
                result = await this.toolExecutor.openUrl(args as { url: string })
                break
              case 'clipboard_read':
                result = this.toolExecutor.clipboardRead()
                break
              case 'clipboard_write':
                result = this.toolExecutor.clipboardWrite(args as { text: string })
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
              case 'browser_action':
                this.browserUsedInCurrentTurn = true
                result = await this.toolExecutor.browserAction(args)
                break
              case 'close_browser':
                result = await this.toolExecutor.closeBrowser()
                break
              default:
                result = `Unknown tool: ${toolName}`
            }

            // Append reminder to tool result to prevent redundant calls
            let toolResult = result
            if (result.includes('already open') || result.includes('DO NOT call')) {
              logger.debug('Adding reminder to tool result in continuation to prevent redundant tool calls')
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
          } catch (error: unknown) {
            const errorMsg = errorMessage(error)
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

        logger.debug('More tools to execute, continuing recursively...')
        // Continue recursively with incremented iteration count
        await this.continueWithToolResults(openai, model, tools, iterationCount + 1)
      } else {
        logger.debug('No more tools to execute, continuation complete')
      }
    } catch (error: unknown) {
      if (errorName(error) !== 'AbortError') {
        logger.error('===== CONTINUATION ERROR =====')
        logger.error('Error name:', errorName(error))
        logger.error('Error message:', errorMessage(error))
        logger.error('Error stack:', errorStack(error))
        logger.error('Full error:', JSON.stringify(error, null, 2))
      } else {
        logger.debug('Continuation aborted by user')
      }
    }
  }

  private async buildSystemMessage(): Promise<string> {
    // Minimal client context - let backend handle all instructions
    // Backend will add language rules, tool usage instructions, user memory, etc.

    const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'

    let systemMessage = `Client: Alia Cowork Desktop (${platform})`

    if (this.currentMode === 'ask') {
      systemMessage += `\n\n## Mode: ASK\nConfirm destructive operations only.`
    } else if (this.currentMode === 'edit') {
      systemMessage += `\n\n## Mode: EDIT\nMake changes directly without confirmation.`
    } else if (this.currentMode === 'yolo') {
      systemMessage += `\n\n## Mode: YOLO\nFull autonomous mode. Execute everything.`
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

  private formatErrorMessage(error: unknown): string {
    const message = errorMessage(error, 'An error occurred')

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

  async getUserInfo(): Promise<unknown> {
    const apiKey = store.get('apiKey') as string
    const baseUrl = store.get('apiBaseUrl') as string

    if (!apiKey) return null

    try {
      const response = await fetch(`${baseUrl}/v1/me`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      })

      if (!response.ok) return null

      return await response.json()
    } catch {
      return null
    }
  }

  async getModels(): Promise<unknown[]> {
    const baseUrl = store.get('apiBaseUrl') as string

    try {
      const response = await fetch(`${baseUrl}/v1/models?category=coding`)

      if (!response.ok) return []

      const data = await response.json() as { data?: unknown[] }
      return data.data || []
    } catch {
      return []
    }
  }

  async getUserMemory(): Promise<unknown> {
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
