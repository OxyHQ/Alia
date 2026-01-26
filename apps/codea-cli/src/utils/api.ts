import OpenAI from 'openai';
import { config } from './config.js';

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface StreamCallbacks {
  onContent: (content: string) => void;
  onToolCall: (toolCall: ToolCall) => void;
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
      description: 'Make targeted edits to a file by replacing specific text',
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
      description: 'Search for text patterns across files',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The search pattern (regex supported)' },
          path: { type: 'string', description: 'Directory to search in (default: current)' },
          file_pattern: { type: 'string', description: 'File glob pattern (e.g., "*.ts")' }
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
  const apiKey = config.get('apiKey') as string;
  const baseUrl = config.get('apiBaseUrl') as string || 'https://api.alia.onl';

  const openai = new OpenAI({
    apiKey,
    baseURL: `${baseUrl}/v1`
  });

  const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemMessage },
    ...messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.tool_call_id!, content: m.content };
      } else if (m.tool_calls) {
        return { role: 'assistant', content: m.content || '', tool_calls: m.tool_calls as any };
      }
      return { role: m.role, content: m.content };
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

    callbacks.onDone(fullContent, toolCalls.length > 0 ? toolCalls : undefined);
  } catch (error: any) {
    callbacks.onError(error);
  }
}

export async function fetchModels(): Promise<any[]> {
  const baseUrl = config.get('apiBaseUrl') || 'https://api.alia.onl';

  try {
    const response = await fetch(`${baseUrl}/v1/models?category=coding`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch {
    return [];
  }
}
