/**
 * Chat Provider — Alia's product runtime, driven from the Electron main process.
 *
 * Streams `POST /alia/chat` through `./alia-chat` and runs the tools the model
 * asks for on this machine. The renderer is a display: it receives
 * `chat:start`, `chat:thinking`, `chat:stream`, `chat:tool`, `chat:toolResult`,
 * `chat:modeChanged`, `chat:error` and `chat:end`, and holds no credential.
 *
 * ## One loop, not two
 *
 * This file used to be two copies of the same ~300-line turn — `handleMessage`
 * for the first request and `continueWithToolResults` for every request after a
 * tool round — with the tool dispatch `switch` written out in both. They had
 * already drifted: the continuation caught its own errors and never told the
 * renderer, so a failure after a tool call ended the turn with no message. A
 * turn is one loop now: stream, collect tool calls, run them, repeat until the
 * model answers in text or the round budget is spent.
 */

import type { BrowserWindow } from 'electron';
import type OpenAI from 'openai';
import { AliaServerClient, createAliaTurnControl, type AliaTurnControl } from '@alia.onl/server';
import Store from 'electron-store';
import type { ToolExecutor } from './tools';
import { errorMessage, errorName, errorStack } from './errors';
import { createLogger } from './logger';
import { isModelId, loadCatalogue, resolveModelId, type Catalogue } from './catalogue';
import { currentAccessToken, linkedAliaClient, onSessionContextChange } from './auth';
import {
  AliaChatError,
  completedToolCalls,
  isCreditsRefusal,
  mergeToolCallDeltas,
  streamAliaChat,
  type AliaStreamEvent,
  type StreamedToolCall,
  withFailureDetail,
} from './alia-chat';

/** A file/folder context item attached to a chat message from the renderer. */
interface ContextItem {
  type: 'file' | 'folder';
  path: string;
  content?: string;
  language?: string;
}

const logger = createLogger('ChatProvider');

/**
 * `model` has no default on purpose: unset means "omit `model` and let the
 * server answer with its own default". It holds the person's pick from the
 * model picker, a `publisher/model` id from `GET /catalogue`.
 */
const store = new Store<{ apiBaseUrl: string; enableTools: boolean; model?: string }>({
  defaults: {
    apiBaseUrl: 'https://api.alia.onl',
    enableTools: true,
  },
});

/**
 * How many tool rounds one user message may take before the model is told to
 * answer with what it has. The server bounds its own steps the same way
 * (`stopWhen: stepCountIs(5)` in `lib/chat/model-config.ts`).
 */
const MAX_TOOL_ROUNDS = 5;

/**
 * The tools this process executes, in the OpenAI function shape the server
 * accepts as `body.tools` and hands back by ORIGINAL name on the `tool_calls`
 * frame (`packages/api/src/lib/tool-converter.ts`). Alia does not run these —
 * its server-side executor for a client tool is an echo — so the names here and
 * the `switch` in {@link ChatProvider.executeTool} are the whole contract.
 */
const COWORK_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file from the filesystem',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
          start_line: { type: 'number', description: 'Optional starting line (1-indexed)' },
          end_line: { type: 'number', description: 'Optional ending line (1-indexed)' },
        },
        required: ['path'],
      },
    },
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
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
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
          new_text: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List files inside a folder the user explicitly selected for this Cowork session.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path inside a user-selected root' },
          recursive: { type: 'boolean', description: 'List recursively' },
        },
      },
    },
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
          path: { type: 'string', description: 'Directory to search in' },
        },
        required: ['pattern'],
      },
    },
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
          cwd: { type: 'string', description: 'Working directory' },
        },
        required: ['command'],
      },
    },
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
            description: 'Application name or file path to open',
          },
        },
        required: ['application_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description:
        'DEPRECATED: Open a URL in external system browser. DO NOT USE THIS - use browser_action instead for all web navigation. Only use this if user explicitly asks to open in external browser.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open in external browser' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_read',
      description: 'Read the current clipboard content',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_write',
      description: 'Write text to the clipboard',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to copy to clipboard' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_system_info',
      description: 'Get system information (OS, CPU, memory, etc.)',
      parameters: { type: 'object', properties: {} },
    },
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
            description:
              'Optional file path to save the screenshot (e.g., ~/Desktop/screenshot.png, C:\\Users\\username\\Desktop\\screenshot.png)',
          },
        },
      },
    },
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
            description: 'The mode to switch to',
          },
        },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_installed_applications',
      description:
        'List all installed applications on the system. Use this to find the correct name/path for apps before trying to open them.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_action',
      description:
        'PRIMARY TOOL FOR WEB NAVIGATION: Navigate to websites, interact with pages, extract data using AI-powered browser automation. Automatically switches to browser tab with live preview. Use this for ALL web browsing tasks (opening URLs, searching, filling forms, clicking, extracting data, etc).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          action: {
            type: 'string',
            description:
              'Natural language description of the action to perform (e.g., "click on login button", "fill the search box with AI", "scroll down to the footer")',
          },
          extract: {
            type: 'string',
            description:
              'Natural language description of data to extract from the page (e.g., "the price of the first product", "all article titles", "the contact email")',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_browser',
      description: 'Close the browser tab and return to chat',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/** What one streamed request produced, after the stream closed. */
interface StreamOutcome {
  text: string;
  toolCalls: StreamedToolCall[];
  /** The server sent a stand-in instead of (or after) an answer. */
  synthetic: { retryable: boolean } | null;
}

/** One user message's run: its id tells a turn that was stopped from the one that replaced it. */
interface Turn {
  id: number;
  historyGeneration: number;
  controller: AbortController;
  lifetime: AbortController;
  control?: AliaTurnControl;
  stopping?: Promise<void>;
}

const abortError = (): Error => Object.assign(new Error('Aborted'), { name: 'AbortError' });

interface TurnRequest {
  baseUrl: string;
  /** Omitted from the request when `undefined`: the server uses its default. */
  model: string | undefined;
  tools: OpenAI.Chat.ChatCompletionTool[] | undefined;
}

/**
 * Build the user message the renderer's context items describe.
 *
 * Folders are mentioned by path for the tools to explore; files are inlined as
 * fenced blocks; an image makes the message multipart so the image travels as
 * an `image_url` part rather than as text.
 */
function buildUserMessage(
  content: string,
  context: ContextItem[] | undefined,
): OpenAI.Chat.ChatCompletionUserMessageParam {
  const folders = context?.filter((item) => item.type === 'folder') ?? [];
  const files = context?.filter((item) => item.type === 'file') ?? [];
  const images = files.filter((item) => item.language === 'image');

  let text = content;
  if (folders.length > 0) {
    text += '\n\n**Attached Folders** (use list_files and read_file tools to explore):';
    for (const folder of folders) text += `\n- ${folder.path}`;
  }
  for (const item of files) {
    if (item.language === 'image') continue;
    text += `\n\n**File: ${item.path}**\n\`\`\`${item.language || ''}\n${item.content}\n\`\`\``;
  }

  if (images.length === 0) return { role: 'user', content: text };

  const parts: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text }];
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.content ?? '' } });
  }
  return { role: 'user', content: parts };
}

export class ChatProvider {
  private window: BrowserWindow;
  private toolExecutor: ToolExecutor;
  private messages: Array<OpenAI.Chat.ChatCompletionMessageParam> = [];
  private currentMode = 'ask';
  /** The turn the renderer is showing, or `null`. `stop()` clears it before the turn has wound down. */
  private activeTurn: Turn | null = null;
  private turnSeq = 0;
  private historyGeneration = 0;
  /** Settles when the latest turn has fully wound down (a stopped one may still be finishing a tool). */
  private settled: Promise<void> = Promise.resolve();
  private browserUsedInCurrentTurn = false;
  /** Whether any real answer text reached the renderer this turn. */
  private streamedTextThisTurn = false;
  private readonly disposeSessionObserver: () => void;
  private contextChanged = false;

  constructor(window: BrowserWindow, toolExecutor: ToolExecutor) {
    this.window = window;
    this.toolExecutor = toolExecutor;
    this.disposeSessionObserver = onSessionContextChange(() => {
      this.contextChanged = true;
      this.clear();
    });
  }

  /** The window a macOS `activate` creates after the last one closed takes over from the old one. */
  setWindow(window: BrowserWindow): void {
    this.window = window;
  }

  private send(channel: string, data: unknown): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(channel, data);
  }

  /** Tell the renderer something about `turn`: nothing, once the turn was stopped or replaced. */
  private emit(turn: Turn, channel: string, data: unknown): void {
    if (this.activeTurn === turn) this.send(channel, data);
  }

  async handleMessage(
    content: string,
    mode: string = 'ask',
    model?: string,
    context?: ContextItem[],
  ): Promise<void> {
    // Claimed before the first await: two sends in the same tick must not both start a turn.
    if (this.activeTurn !== null) return;

    if (currentAccessToken() === null) {
      this.send('chat:error', { message: 'Sign in to Alia to start a conversation.' });
      return;
    }

    const turn: Turn = {
      id: ++this.turnSeq,
      historyGeneration: this.historyGeneration,
      controller: new AbortController(),
      lifetime: new AbortController(),
    };
    this.activeTurn = turn;
    const previous = this.settled;
    const run = this.runMessage(turn, previous, content, mode, model, context);
    this.settled = run.catch(() => undefined);
    await run;
  }

  private async runMessage(
    turn: Turn,
    previous: Promise<void>,
    content: string,
    mode: string,
    model: string | undefined,
    context: ContextItem[] | undefined,
  ): Promise<void> {
    try {
      // A stopped turn may still be finishing a tool: its results belong in the history before
      // this message does.
      await previous;
      if (turn.controller.signal.aborted) return;
      // A cancelled local tool may have finished after the account changed.
      // Its late history is discarded before the next account starts a turn.
      if (this.contextChanged) {
        this.resetHistory();
        turn.historyGeneration = this.historyGeneration;
        this.contextChanged = false;
      }

      const baseUrl = store.get('apiBaseUrl') as string;
      /**
       * Resolved once, here, and then carried through every tool-round
       * continuation of this message. Resolving per request could change the
       * model mid-conversation if the catalogue shifted underneath it.
       * `undefined` — nothing chosen, or a choice the catalogue no longer lists —
       * omits `model` and the server answers with its default.
       */
      const requestedModel = model || store.get('model');
      const selectedModel = await resolveModelId(baseUrl, requestedModel);
      if (turn.controller.signal.aborted) return;
      const enableTools = store.get('enableTools') as boolean;

      this.currentMode = mode;
      this.browserUsedInCurrentTurn = false;
      this.streamedTextThisTurn = false;

      this.messages.push(buildUserMessage(content, context));
      if (this.messages.length === 1) {
        this.messages.unshift({ role: 'system', content: this.buildSystemMessage() });
      }

      this.emit(turn, 'chat:start', {});

      logger.debug('===== NEW MESSAGE =====');
      logger.debug('Mode:', mode);
      logger.debug('Model:', selectedModel ?? '(server default)');
      logger.debug('Base URL:', baseUrl);
      logger.debug('Tools enabled:', enableTools);
      logger.debug('Message count:', this.messages.length);

      try {
        await this.runTurn(turn, {
          baseUrl,
          model: selectedModel,
          tools: enableTools ? COWORK_TOOLS : undefined,
        });
        this.emit(turn, 'chat:end', {});
      } catch (error: unknown) {
        const stoppedByServer =
          turn.stopping !== undefined &&
          error instanceof AliaChatError &&
          error.code === 'turn_cancelled';
        if (errorName(error) === 'AbortError' || stoppedByServer) {
          logger.debug('Stream aborted by user');
          this.emit(turn, 'chat:end', {});
        } else {
          logger.error('===== STREAM ERROR =====');
          logger.error('Error name:', errorName(error));
          logger.error('Error message:', errorMessage(error));
          logger.error('Error stack:', errorStack(error));
          /**
           * `chat:error` discards whatever the renderer was still streaming, so
           * an answer that was interrupted part-way is committed first — the
           * renderer commits on `chat:end` — and the error lands under it. That
           * is what the app does with a synthetic tail after real output.
           */
          if (this.streamedTextThisTurn) this.emit(turn, 'chat:end', {});
          this.emit(turn, 'chat:error', { message: this.formatErrorMessage(error) });
        }
      }
    } finally {
      if (this.browserUsedInCurrentTurn) {
        logger.debug('Browser was used, auto-closing and returning to chat...');
        try {
          await this.toolExecutor.closeBrowser();
        } catch (error) {
          logger.error('Error auto-closing browser:', error);
        }
      }
      logger.debug('===== SESSION END =====');
      logger.debug('Final message count:', this.messages.length);
      turn.lifetime.abort();
      // Only the turn that still owns the provider hands it back: a stopped turn finishing late
      // must not end the one that replaced it.
      if (this.activeTurn === turn) {
        this.activeTurn = null;
        this.browserUsedInCurrentTurn = false;
      }
    }
  }

  /**
   * One user message, to completion: stream, run tools, stream again.
   *
   * The final round is sent with `tool_choice: 'none'` so a model that would
   * keep calling tools is made to answer instead of being cut off silently.
   */
  private async runTurn(turn: Turn, request: TurnRequest): Promise<void> {
    for (let round = 0; ; round++) {
      // A stopped turn that finished a tool does not start another request.
      if (turn.controller.signal.aborted) throw abortError();
      const lastRound = round >= MAX_TOOL_ROUNDS;
      if (lastRound)
        logger.warn(`Max tool rounds (${MAX_TOOL_ROUNDS}) reached, forcing final response`);

      const outcome = await this.streamOnce(turn, request, lastRound);
      if (turn.historyGeneration !== this.historyGeneration) return;

      // A stand-in turn never runs its tools, so its `tool_calls` are not remembered either: an
      // assistant message that asks for tools nobody answers is a history the server refuses.
      const remembered = outcome.synthetic === null ? outcome.toolCalls : [];
      if (outcome.text || remembered.length > 0) {
        const assistant: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: outcome.text || null,
        };
        if (remembered.length > 0) assistant.tool_calls = remembered;
        this.messages.push(assistant);
      }

      if (outcome.synthetic !== null) {
        // The stand-in was never shown and is never remembered: the history
        // holds whatever real output preceded it, and the person is told.
        throw new AliaChatError(
          outcome.synthetic.retryable
            ? 'Alia could not finish that answer. Please send your message again.'
            : 'Alia could not answer that request.',
          { retryable: outcome.synthetic.retryable },
        );
      }

      if (outcome.toolCalls.length === 0 || lastRound) return;

      logger.debug('===== EXECUTING TOOLS =====');
      logger.debug('Number of tools to execute:', outcome.toolCalls.length);
      for (const [index, toolCall] of outcome.toolCalls.entries()) {
        if (turn.historyGeneration !== this.historyGeneration) return;
        if (turn.controller.signal.aborted) {
          // Stopped between tools: the ones not run are answered as cancelled, so the saved
          // history never holds a request without its result.
          for (const skipped of outcome.toolCalls.slice(index)) this.pushCancelledTool(skipped);
          throw abortError();
        }
        await this.runToolCall(turn, toolCall);
      }
    }
  }

  private pushCancelledTool(toolCall: StreamedToolCall): void {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: 'Error: Cancelled by the user before this tool ran.',
    });
  }

  /**
   * Stream one request and fold what it produced.
   *
   * Shared core transport owns refresh, its single 401 replay and account fencing.
   */
  private async streamOnce(
    turn: Turn,
    request: TurnRequest,
    finalRound: boolean,
  ): Promise<StreamOutcome> {
    const body = {
      ...(request.model === undefined ? {} : { model: request.model }),
      messages: this.messages,
      tools: finalRound ? undefined : request.tools,
      ...(finalRound && request.tools !== undefined ? { tool_choice: 'none' as const } : {}),
      temperature: 0.7,
      max_tokens: 4096,
    };

    const linked = linkedAliaClient(request.baseUrl);
    const control = createAliaTurnControl(
      new AliaServerClient({ baseUrl: request.baseUrl, fetch: linked.fetch }),
      { controller: turn.controller, lifetimeSignal: turn.lifetime.signal },
    );
    turn.control = control;
    try {
      return await this.consume(
        turn,
        streamAliaChat({
          baseUrl: request.baseUrl,
          fetch: linked.fetch,
          body: { ...body, turnId: control.id },
          signal: turn.controller.signal,
        }),
      );
    } finally {
      await control.finish();
      if (turn.control === control) turn.control = undefined;
      linked.dispose();
    }
  }

  /** Forward a stream to the renderer and collect what the history needs. */
  private async consume(
    turn: Turn,
    stream: AsyncIterable<AliaStreamEvent>,
  ): Promise<StreamOutcome> {
    let text = '';
    const toolCalls: StreamedToolCall[] = [];
    let synthetic: StreamOutcome['synthetic'] = null;
    let chunkCount = 0;

    try {
      for await (const event of stream) {
        if (turn.controller.signal.aborted) throw abortError();
        chunkCount++;
        switch (event.type) {
          case 'content':
            text += event.text;
            this.streamedTextThisTurn = true;
            this.emit(turn, 'chat:stream', { content: event.text });
            break;
          case 'reasoning':
            this.emit(turn, 'chat:thinking', { content: event.text });
            break;
          case 'tool_calls':
            mergeToolCallDeltas(toolCalls, event.deltas);
            break;
          case 'synthetic':
            logger.warn('Server sent a synthetic stand-in:', event.text);
            synthetic = { retryable: event.retryable };
            break;
          case 'tool_result':
            // For this process's own tools the output is the server's echo of the
            // arguments; the real result is produced by `runToolCall`.
            logger.debug(`Server tool result for ${event.name}`);
            break;
          case 'finish':
            logger.debug('Stream finished:', event.reason);
            break;
          case 'event':
            logger.debug('Product event:', event.name);
            break;
        }
      }
    } catch (error) {
      // Only the still-owned turn may retain its delivered partial answer.
      if (
        error instanceof AliaChatError &&
        error.code === 'turn_cancelled' &&
        this.activeTurn === turn &&
        !turn.lifetime.signal.aborted &&
        text
      ) {
        this.messages.push({ role: 'assistant', content: text });
      }
      throw error;
    }

    logger.debug('Stream processing complete');
    logger.debug('Total events processed:', chunkCount);
    logger.debug('Assistant message length:', text.length);

    return { text, toolCalls: completedToolCalls(toolCalls), synthetic };
  }

  /** Execute one tool call locally and append its result to the history. */
  private async runToolCall(turn: Turn, toolCall: StreamedToolCall): Promise<void> {
    if (turn.historyGeneration !== this.historyGeneration) return;
    const toolName = toolCall.function.name;
    logger.debug(`Executing tool: ${toolName}`);
    logger.debug(`Tool call ID: ${toolCall.id}`);
    logger.debug(`Raw arguments: ${toolCall.function.arguments}`);

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments || '{}');
    } catch (e) {
      logger.error('Failed to parse tool arguments:', toolCall.function.arguments, e);
      // The model is told rather than left waiting for a result that never
      // comes: a `tool_calls` entry with no matching `tool` message is a
      // request the server refuses.
      this.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: 'Error: Malformed tool arguments. Please retry with valid JSON.',
      });
      this.emit(turn, 'chat:toolResult', {
        tool: toolName,
        success: false,
        result: 'Malformed tool arguments',
      });
      return;
    }

    if (toolName === 'set_mode') {
      logger.debug(`Setting mode to: ${args.mode}`);
      this.currentMode = String(args.mode ?? this.currentMode);
      this.emit(turn, 'chat:modeChanged', { mode: this.currentMode });
    }

    this.emit(turn, 'chat:tool', { tool: toolName, args, status: 'running' });

    try {
      let result = await this.executeTool(toolName, args);
      if (turn.historyGeneration !== this.historyGeneration) return;
      logger.debug(`Tool ${toolName} executed successfully`);
      logger.debug(`Result length: ${result.length}`);

      // A tool that reports "already open" is one the model tends to call
      // again; the reminder is what stops the loop.
      if (result.includes('already open') || result.includes('DO NOT call')) {
        result +=
          '\n\n[SYSTEM REMINDER: The action is complete. Do NOT call the same tool again. Move to the next task or provide your final response.]';
      }

      this.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      this.emit(turn, 'chat:toolResult', {
        tool: toolName,
        success: true,
        result: result.slice(0, 500),
      });
    } catch (error: unknown) {
      if (turn.historyGeneration !== this.historyGeneration) return;
      const errorMsg = errorMessage(error);
      logger.error(`Tool ${toolName} execution failed:`, errorMsg);
      logger.error('Error stack:', errorStack(error));
      this.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: `Error: ${errorMsg}`,
      });
      this.emit(turn, 'chat:toolResult', { tool: toolName, success: false, result: errorMsg });
    }
  }

  /** Dispatch by the name the server handed back — the ORIGINAL name. */
  private async executeTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'read_file':
        return this.toolExecutor.readFile(
          args as { path: string; start_line?: number; end_line?: number },
        );
      case 'write_file':
        return this.toolExecutor.writeFile(args as { path: string; content: string });
      case 'edit_file':
        return this.toolExecutor.editFile(
          args as { path: string; old_text: string; new_text: string },
        );
      case 'list_files':
        return this.toolExecutor.listFiles(args as { path?: string; recursive?: boolean });
      case 'search_files':
        return this.toolExecutor.searchFiles(args as { pattern: string; path?: string });
      case 'run_command':
        return this.toolExecutor.runCommand(args as { command: string; cwd?: string });
      case 'open_application':
        return this.toolExecutor.openApplication(args as { application_name: string });
      case 'open_url':
        return this.toolExecutor.openUrl(args as { url: string });
      case 'clipboard_read':
        return this.toolExecutor.clipboardRead();
      case 'clipboard_write':
        return this.toolExecutor.clipboardWrite(args as { text: string });
      case 'get_system_info':
        return this.toolExecutor.getSystemInfo();
      case 'screenshot':
        return this.toolExecutor.screenshot();
      case 'set_mode':
        return `Mode changed to ${args.mode}`;
      case 'list_installed_applications':
        return this.toolExecutor.listInstalledApplications();
      case 'browser_action':
        this.browserUsedInCurrentTurn = true;
        return this.toolExecutor.browserAction(args);
      case 'close_browser':
        return this.toolExecutor.closeBrowser();
      default:
        logger.error(`Unknown tool: ${toolName}`);
        return `Unknown tool: ${toolName}`;
    }
  }

  private buildSystemMessage(): string {
    // Minimal client context. The server replaces this system message with its
    // own complete prompt and folds this text in as client context
    // (`lib/chat/request-context.ts`), so language rules, tool instructions
    // and memory are its business.
    const platform =
      process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';

    let systemMessage = `Client: Alia Cowork Desktop (${platform})`;

    if (this.currentMode === 'ask') {
      systemMessage += `\n\n## Mode: ASK\nConfirm destructive operations only.`;
    } else if (this.currentMode === 'edit') {
      systemMessage += `\n\n## Mode: EDIT\nMake changes directly without confirmation.`;
    } else if (this.currentMode === 'yolo') {
      systemMessage += `\n\n## Mode: YOLO\nFull autonomous mode. Execute everything.`;
    }

    return systemMessage;
  }

  dispose(): void {
    this.disposeSessionObserver();
    this.clear();
  }

  stop(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) return Promise.resolve();
    if (turn.stopping) return turn.stopping;
    turn.stopping = (async () => {
      // A completed local tool is never undone. Only its current HTTP generation
      // has remote control; between rounds Stop simply prevents the next one.
      if (turn.control) await turn.control.stop();
      if (this.activeTurn === turn) this.detach();
    })().catch(() => {
      turn.stopping = undefined;
      this.emit(turn, 'chat:error', {
        message: 'Generation could not be stopped. Try again.',
        generationContinues: true,
      });
    });
    return turn.stopping;
  }

  private detach(): void {
    // Release the provider now (a new message may start at once) and cut the stopped turn's
    // stream; the turn winds down on its own, and the next one waits for it.
    const turn = this.activeTurn;
    this.activeTurn = null;
    turn?.lifetime.abort();
    turn?.controller.abort();
    this.send('chat:end', {});
  }

  clear(): void {
    this.detach();
    this.resetHistory();
  }

  private resetHistory(): void {
    this.historyGeneration++;
    this.messages = [];
    this.toolExecutor.reset();
    this.send('chat:cleared', {});
  }

  /**
   * What the renderer shows for a failure.
   *
   * A structured refusal carries its own message and, where the server sent
   * one, a code — `MODEL_NOT_IN_PLAN` reads "Upgrade your plan to use this
   * model." exactly as the server wrote it. The status branches are for the
   * refusals whose server message is not written for a person.
   */
  private formatErrorMessage(error: unknown): string {
    if (error instanceof AliaChatError) {
      // A typed refusal says what it is: its message, its code and its run
      // reference. The status-only wording is for refusals that carry no code.
      if (error.code !== null && !isCreditsRefusal(error) && error.status !== 401) {
        return withFailureDetail(error.message, error);
      }
      switch (error.status) {
        case 401:
          return 'Your Alia session has expired. Sign out and sign in again.';
        case 402:
          return isCreditsRefusal(error)
            ? 'Insufficient credits. Please add more credits at alia.onl'
            : withFailureDetail(error.message, error);
        case 429:
          return 'Rate limit exceeded. Please wait a moment and try again.';
        case 500:
          return 'Server error. Please try again later.';
        case 502:
        case 503:
        case 504:
          return 'Service unavailable. Please try again later.';
        default:
          return withFailureDetail(error.message, error);
      }
    }

    const message = errorMessage(error, 'An error occurred');
    if (message.toLowerCase().includes('insufficient credits')) {
      return 'Insufficient credits. Please add more credits at alia.onl';
    }
    if (message.toLowerCase().includes('rate limit')) {
      return 'Rate limit exceeded. Please wait a moment and try again.';
    }
    return message;
  }

  /**
   * The catalogue for the model picker, or `null` when it could not be read
   * (the picker then offers only the server default).
   */
  async getModels(): Promise<Catalogue | null> {
    const baseUrl = store.get('apiBaseUrl') as string;
    try {
      return await loadCatalogue(baseUrl);
    } catch (error: unknown) {
      logger.debug('model catalogue unavailable:', errorMessage(error));
      return null;
    }
  }

  /** The stored pick, or `null` for the server default. */
  getSelectedModel(): string | null {
    const stored = store.get('model');
    return isModelId(stored) ? stored : null;
  }

  /** Persist the picker's choice; `null` (or anything not a model id) clears it. */
  selectModel(modelId: string | null): void {
    if (isModelId(modelId)) store.set('model', modelId);
    else store.delete('model');
  }

  async getUserInfo(): Promise<unknown> {
    const accessToken = currentAccessToken();
    const baseUrl = store.get('apiBaseUrl') as string;

    if (!accessToken) return null;

    const linked = linkedAliaClient(baseUrl);
    try {
      const response = await linked.fetch(`${baseUrl}/v1/me`, {
        method: 'GET',
      });

      if (!response.ok) return null;

      return await response.json();
    } catch {
      return null;
    } finally {
      linked.dispose();
    }
  }

  async getUserMemory(): Promise<unknown> {
    const accessToken = currentAccessToken();
    const baseUrl = store.get('apiBaseUrl') as string;

    if (!accessToken) return null;

    const linked = linkedAliaClient(baseUrl);
    try {
      const response = await linked.fetch(`${baseUrl}/memory`, {
        method: 'GET',
      });

      if (!response.ok) return null;

      return await response.json();
    } catch {
      return null;
    } finally {
      linked.dispose();
    }
  }
}
