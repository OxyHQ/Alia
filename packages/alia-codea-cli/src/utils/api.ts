import OpenAI from 'openai';
import { config } from './config.js';
import type { Message, ToolCall } from './conversation.js';

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
          path: { type: 'string', description: 'The file path to read' }
        },
        required: ['path']
      }
    }
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
          content: { type: 'string', description: 'The content to write' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Make targeted edits to a file by replacing specific text. For small single-location changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The file path to edit' },
          old_text: { type: 'string', description: 'The text to find and replace' },
          new_text: { type: 'string', description: 'The replacement text' }
        },
        required: ['path', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply a unified diff patch to one or more files. Preferred for multi-line or multi-file changes. Uses standard unified diff format with fuzzy line matching (±20 line drift).',
      parameters: {
        type: 'object',
        properties: {
          patch: {
            type: 'string',
            description: 'The unified diff patch text. Must include --- a/file and +++ b/file headers and @@ hunk headers.'
          }
        },
        required: ['patch']
      }
    }
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
          recursive: { type: 'boolean', description: 'Whether to list recursively' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for text patterns across files. Uses ripgrep when available for fast results with context lines.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The search pattern (regex supported)' },
          path: { type: 'string', description: 'Directory to search in (default: current)' },
          file_pattern: { type: 'string', description: 'File glob pattern (e.g., "*.ts")' },
          context_lines: { type: 'number', description: 'Number of context lines around matches (default: 2)' },
          max_results: { type: 'number', description: 'Maximum number of matches to return (default: 50)' }
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
          command: { type: 'string', description: 'The command to execute' },
          cwd: { type: 'string', description: 'Working directory (default: current)' }
        },
        required: ['command']
      }
    }
  }
];

export async function streamChat(
  messages: Message[],
  systemMessage: string,
  model: string,
  callbacks: StreamCallbacks
): Promise<void> {
  const apiKey = config.get('apiKey');
  if (!apiKey) throw new Error('No API key configured. Run `codea login` first.');

  const baseUrl = config.get('apiBaseUrl') || 'https://api.ai.oxy.so';

  const openai = new OpenAI({
    apiKey,
    baseURL: `${baseUrl}/v1`
  });

  const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemMessage },
    ...messages.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, tool_call_id: m.tool_call_id!, content: m.content };
      } else if (m.tool_calls) {
        return {
          role: 'assistant' as const,
          content: m.content || '',
          tool_calls: m.tool_calls as unknown as OpenAI.Chat.ChatCompletionMessageToolCall[],
        };
      }
      return { role: m.role as 'user' | 'assistant', content: m.content };
    })
  ];

  try {
    const stream = await openai.chat.completions.create({
      model,
      messages: allMessages,
      tools: fileTools as OpenAI.Chat.ChatCompletionTool[],
      stream: true
    });

    let fullContent = '';
    const toolCalls: ToolCall[] = [];
    const toolCallsMap = new Map<number, ToolCall>();

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        fullContent += delta.content;
        callbacks.onContent(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;

          if (!toolCallsMap.has(index)) {
            const newToolCall: ToolCall = {
              id: tc.id || '',
              type: 'function',
              function: {
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || ''
              }
            };
            toolCallsMap.set(index, newToolCall);
            toolCalls.push(newToolCall);
          } else {
            const existingToolCall = toolCallsMap.get(index)!;
            if (tc.function?.name) {
              existingToolCall.function.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              existingToolCall.function.arguments += tc.function.arguments;
            }
          }
        }
      }
    }

    // Validate tool call arguments before returning
    for (const tc of toolCalls) {
      try {
        JSON.parse(tc.function.arguments);
      } catch {
        tc.function.arguments = '{}';
      }
    }

    callbacks.onDone(fullContent, toolCalls.length > 0 ? toolCalls : undefined);
  } catch (error: unknown) {
    callbacks.onError(new Error(extractErrorMessage(error)));
  }
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return 'Unknown error occurred';
  const e = error as Record<string, unknown>;
  // OpenAI SDK structured errors
  if (typeof e.error === 'object' && e.error !== null) {
    const inner = e.error as Record<string, unknown>;
    if (typeof inner.message === 'string') return inner.message;
  }
  // Standard Error objects
  if (typeof e.message === 'string') return e.message;
  // HTTP status only
  if (typeof e.status === 'number') return `API error (HTTP ${e.status})`;
  return 'Unknown error occurred';
}
