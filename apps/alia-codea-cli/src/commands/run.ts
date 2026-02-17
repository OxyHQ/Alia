import chalk from 'chalk';
import { config } from '../utils/config.js';
import { streamChat } from '../utils/api.js';
import { executeTool, formatToolCall } from '../tools/executor.js';
import { buildSystemMessage, getCodebaseContext } from '../utils/context.js';
import {
  printToolExecution,
  printToolResult,
  showThinkingStatus,
  hideThinkingStatus,
  printAssistantPrefix,
  printError,
  printInfo
} from '../utils/ui.js';

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface RunOptions {
  model: string;
  yes: boolean;
  context: boolean;
}

export async function runPrompt(prompt: string, options: RunOptions): Promise<void> {
  const messages: Message[] = [];

  // Get codebase context
  let codebaseContext = '';
  if (options.context !== false) {
    codebaseContext = await getCodebaseContext();
  }

  // Add user message
  messages.push({ role: 'user', content: prompt });

  // Build system message
  const systemMessage = buildSystemMessage(options.model, codebaseContext);

  // Process with tool loop
  await processConversation(messages, systemMessage, options.model, options.yes);
}

async function processConversation(
  messages: Message[],
  systemMessage: string,
  model: string,
  autoApprove: boolean
): Promise<void> {
  let continueProcessing = true;

  while (continueProcessing) {
    printAssistantPrefix();

    let fullContent = '';
    let toolCalls: any[] | undefined;

    showThinkingStatus('Thinking');

    try {
      await streamChat(messages, systemMessage, model, {
        onContent: (content) => {
          hideThinkingStatus();
          process.stdout.write(content);
          fullContent += content;
        },
        onToolCall: () => {},
        onDone: (content, tcs) => {
          hideThinkingStatus();
          toolCalls = tcs;
        },
        onError: (error) => {
          hideThinkingStatus();
          printError(error.message);
          continueProcessing = false;
        }
      });
    } catch (error: any) {
      hideThinkingStatus();
      printError(error.message);
      break;
    }

    // Handle tool calls
    if (toolCalls && toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: fullContent,
        tool_calls: toolCalls
      });

      if (fullContent) console.log();

      for (const tc of toolCalls) {
        const args = JSON.parse(tc.function.arguments);

        // Check if we need approval for file writes
        const isDestructive = ['write_file', 'edit_file', 'run_command'].includes(tc.function.name);

        if (isDestructive && !autoApprove) {
          console.log();
          console.log(chalk.yellow('⚠ ') + chalk.bold('Approval required:'));
          console.log(formatToolCall(tc.function.name, args));
          console.log();

          const approved = await askApproval();
          if (!approved) {
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: 'User declined this action.'
            });
            continue;
          }
        }

        printToolExecution(tc.function.name, formatToolArgs(tc.function.name, args));

        showThinkingStatus(`Executing ${tc.function.name}`);
        const result = await executeTool(tc.function.name, args);
        hideThinkingStatus();

        printToolResult(result.success, result.result);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.result
        });
      }

      continue;
    } else {
      if (fullContent) {
        messages.push({ role: 'assistant', content: fullContent });
        console.log();
      }
      break;
    }
  }
}

async function askApproval(): Promise<boolean> {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(chalk.cyan('Allow? [y/N] '), (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

function formatToolArgs(name: string, args: Record<string, any>): string {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return args.path || '';
    case 'list_files':
      return args.path || '.';
    case 'search_files':
      return `"${args.pattern}" in ${args.path || '.'}`;
    case 'run_command':
      return args.command || '';
    default:
      return JSON.stringify(args).slice(0, 50);
  }
}
