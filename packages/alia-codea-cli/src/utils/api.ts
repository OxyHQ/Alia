import { AliaServerClient, createAliaTurnControl } from '@alia.onl/server';
import type { ConversationControl } from './turn-control.js';
import { config } from './config.js';
import type { Message, ToolCall } from './conversation.js';
import { resolveModelId } from './catalogue.js';
import { linkedAliaClient, restoreSession, onSessionContextChange } from './oxy-session.js';
import {
  AliaChatError,
  completedToolCalls,
  isCreditsRefusal,
  mergeToolCallDeltas,
  streamAliaChat,
  type StreamedToolCall,
  withFailureDetail,
} from './alia-chat.js';

interface StreamCallbacks {
  onContent: (content: string) => void;
  onDone: (content: string, toolCalls?: ToolCall[]) => void;
  onError: (error: Error) => void;
}

export const fileTools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The file path to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (creates or overwrites)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The file path to write to' },
          content: { type: 'string', description: 'The content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Make targeted edits to a file by replacing specific text. For small single-location changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The file path to edit' },
          old_text: { type: 'string', description: 'The text to find and replace' },
          new_text: { type: 'string', description: 'The replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Apply a unified diff patch to one or more files. Preferred for multi-line or multi-file changes. Uses standard unified diff format with fuzzy line matching (±20 line drift).',
      parameters: {
        type: 'object',
        properties: {
          patch: {
            type: 'string',
            description:
              'The unified diff patch text. Must include --- a/file and +++ b/file headers and @@ hunk headers.',
          },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a directory',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The directory path (default: current directory)' },
          recursive: { type: 'boolean', description: 'Whether to list recursively' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Search for text patterns across files. Uses ripgrep when available for fast results with context lines.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The search pattern (regex supported)' },
          path: { type: 'string', description: 'Directory to search in (default: current)' },
          file_pattern: { type: 'string', description: 'File glob pattern (e.g., "*.ts")' },
          context_lines: {
            type: 'number',
            description: 'Number of context lines around matches (default: 2)',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of matches to return (default: 50)',
          },
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
          command: { type: 'string', description: 'The command to execute' },
          cwd: { type: 'string', description: 'Working directory (default: current)' },
        },
        required: ['command'],
      },
    },
  },
];

/**
 * Stream one request to Alia's product runtime and report what it produced.
 *
 * `onContent` fires per answer fragment, `onDone` once with the whole answer
 * and any tool calls, `onError` instead of `onDone` when the turn failed.
 * Three outcomes deserve saying out loud:
 *
 *  - **The server's stand-in is an error, not an answer.** A chunk flagged
 *    `alia_meta.synthetic` — "I'm sorry, all models are currently busy" — is
 *    never passed to `onContent`, so it is never printed, never pushed into
 *    the conversation and never saved into the session file for `codea
 *    resume` to replay. Its `retryable` flag decides the message.
 *  - **An abort is silent.** When `signal` fires neither callback runs: the
 *    reader has detached. Only an acknowledged explicit Stop cancels the
 *    durable turn; billing follows the server's measured settlement.
 *  - **Named product events are read, not dropped.** `alia.reasoning` has no
 *    terminal surface yet and is ignored on purpose; the rest are logged
 *    nowhere because a CLI has nowhere to put them.
 */
export async function streamChat(
  messages: Message[],
  systemMessage: string,
  model: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  control?: ConversationControl,
): Promise<void> {
  if (signal?.aborted || control?.stopped) return;
  if (!(await restoreSession())) throw new Error('Not signed in. Run `codea login` first.');
  if (signal?.aborted || control?.stopped) return;
  const linked = linkedAliaClient();

  const baseUrl = config.get('apiBaseUrl') || 'https://api.alia.onl';
  const controller = new AbortController();
  const accountLifetime = new AbortController();
  const lifetimeSignal = control
    ? AbortSignal.any([accountLifetime.signal, control.lifetimeSignal])
    : accountLifetime.signal;
  const streamSignal = AbortSignal.any([
    controller.signal,
    lifetimeSignal,
    ...(signal ? [signal] : []),
  ]);
  control?.bindAccount(() => onSessionContextChange(() => control.dispose()));
  const removeSessionListener = onSessionContextChange(() => {
    accountLifetime.abort();
    controller.abort();
    control?.dispose();
  });
  const client = new AliaServerClient({ baseUrl, path: '/alia/chat', fetch: linked.fetch });
  const turn = createAliaTurnControl(client, { controller, lifetimeSignal });

  const allMessages: Message[] = [
    { role: 'system', content: systemMessage },
    ...messages.map((m): Message => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, tool_call_id: m.tool_call_id!, content: m.content };
      } else if (m.tool_calls) {
        return {
          role: 'assistant' as const,
          content: m.content || '',
          tool_calls: m.tool_calls,
        };
      }
      return { role: m.role as 'user' | 'assistant', content: m.content };
    }),
  ];

  try {
    if (control && !control.attach(turn, controller)) return;
    const resolvedModel = await resolveModelId(model, streamSignal);
    if (streamSignal.aborted || control?.stopped) return;
    const stream = streamAliaChat({
      client,
      baseUrl,
      fetch: linked.fetch,
      body: {
        /**
         * Resolved HERE because this is the one place every CLI path — the
         * REPL, `run`, `exec` and a resumed session — actually names a model.
         * `undefined` (no choice, or one the catalogue no longer lists) drops
         * the key, and the server uses its default model.
         */
        model: resolvedModel,
        turnId: turn.id,
        messages: allMessages,
        extra: { tools: fileTools },
      },
      signal: streamSignal,
    });

    let fullContent = '';
    const toolCalls: StreamedToolCall[] = [];
    let synthetic: { retryable: boolean } | null = null;

    for await (const event of stream) {
      switch (event.type) {
        case 'content':
          fullContent += event.text;
          callbacks.onContent(event.text);
          break;
        case 'tool_calls':
          mergeToolCallDeltas(toolCalls, event.deltas);
          break;
        case 'synthetic':
          synthetic = { retryable: event.retryable };
          break;
        case 'reasoning':
        case 'tool_result':
        case 'finish':
        case 'event':
          break;
      }
    }

    if (synthetic !== null) {
      callbacks.onError(
        new Error(
          synthetic.retryable
            ? 'Alia could not finish that answer. Please send your message again.'
            : 'Alia could not answer that request.',
        ),
      );
      return;
    }

    // A call whose arguments never became valid JSON is handed on as `{}` so
    // the executor reports the malformed call rather than the loop crashing.
    const completed = completedToolCalls(toolCalls).map((tc): ToolCall => {
      try {
        JSON.parse(tc.function.arguments);
        return tc;
      } catch {
        return { ...tc, function: { ...tc.function, arguments: '{}' } };
      }
    });

    callbacks.onDone(fullContent, completed.length > 0 ? completed : undefined);
  } catch (error: unknown) {
    if (streamSignal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
    if (control?.stopRequested && error instanceof AliaChatError && error.code === 'turn_cancelled')
      return;
    callbacks.onError(new Error(extractErrorMessage(error)));
  } finally {
    // A terminal SSE can precede the Stop ACK: retain both transport and account fence.
    if (control) await control.finish(turn);
    else await turn.finish();
    removeSessionListener();
    linked.dispose();
  }
}

/**
 * A message a person can act on.
 *
 * The shared reader retains refusal codes/references and excludes untrusted
 * HTTP upstream prose. The two status branches are for the
 * refusals whose server message is not written for a person: the auth
 * middleware's bare `Authentication required`, and a credit refusal.
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof AliaChatError) {
    if (error.status === 401) return 'Your Alia session has expired. Run `codea login` again.';
    if (error.status === 402 && isCreditsRefusal(error)) {
      return 'Insufficient credits. Add more at alia.onl.';
    }
    return withFailureDetail(error.message, error);
  }
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return 'Unknown error occurred';
  const e = error as Record<string, unknown>;
  if (typeof e.message === 'string') return e.message;
  return 'Unknown error occurred';
}
