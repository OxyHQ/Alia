import * as readline from 'readline';
import chalk from 'chalk';
import { config, createSession, saveSession } from '../utils/config.js';
import { streamChat } from '../utils/api.js';
import { executeTool, formatToolCall } from '../tools/executor.js';
import {
  printBanner,
  printTips,
  printPrompt,
  printToolExecution,
  printToolResult,
  showThinkingStatus,
  hideThinkingStatus,
  printStatusBar,
  printAssistantPrefix,
  printError,
  printInfo
} from '../utils/ui.js';
import { buildSystemMessage, getCodebaseContext } from '../utils/context.js';

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface ReplOptions {
  model: string;
  context: boolean;
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const session = createSession();
  const messages: Message[] = [];
  let isProcessing = false;
  let contextUsed = 0;
  const maxContext = 128000;

  // Print welcome UI
  printTips();

  // Get initial codebase context
  let codebaseContext = '';
  if (options.context !== false) {
    printInfo('Analyzing codebase...');
    codebaseContext = await getCodebaseContext();
    if (codebaseContext) {
      printInfo(`Loaded context from ${codebaseContext.split('\n').length} files`);
    }
  }

  // Setup readline
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  // Handle Ctrl+C
  rl.on('SIGINT', () => {
    if (isProcessing) {
      isProcessing = false;
      hideThinkingStatus();
      console.log(chalk.yellow('\nCancelled.'));
      printPrompt();
    } else {
      console.log(chalk.gray('\nGoodbye!'));
      process.exit(0);
    }
  });

  const askQuestion = (): void => {
    printPrompt();
    rl.question('', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        askQuestion();
        return;
      }

      // Handle slash commands
      if (trimmed.startsWith('/')) {
        await handleSlashCommand(trimmed, messages, session, options);
        askQuestion();
        return;
      }

      // Add user message
      messages.push({ role: 'user', content: trimmed });
      isProcessing = true;

      // Build system message
      const systemMessage = buildSystemMessage(options.model, codebaseContext);

      // Process conversation with tool loop
      await processConversation(messages, systemMessage, options.model, () => isProcessing);

      isProcessing = false;

      // Update session
      session.messages = messages.map(m => ({ role: m.role, content: m.content }));
      session.title = messages[0]?.content.slice(0, 50) || 'New conversation';
      session.updatedAt = Date.now();
      saveSession(session);

      // Update context usage estimate
      contextUsed = Math.min(95, Math.floor(messages.reduce((acc, m) => acc + m.content.length, 0) / maxContext * 100));

      // Print status bar
      printStatusBar(process.cwd(), getModelDisplayName(options.model), 100 - contextUsed);

      askQuestion();
    });
  };

  askQuestion();
}

async function processConversation(
  messages: Message[],
  systemMessage: string,
  model: string,
  isActive: () => boolean
): Promise<void> {
  while (isActive()) {
    console.log();
    printAssistantPrefix();

    let fullContent = '';
    let toolCalls: any[] | undefined;

    showThinkingStatus('Thinking');

    try {
      await streamChat(messages, systemMessage, model, {
        onContent: (content) => {
          if (!isActive()) return;
          hideThinkingStatus();
          process.stdout.write(content);
          fullContent += content;
        },
        onToolCall: (tc) => {
          // Tool calls are accumulated
        },
        onDone: (content, tcs) => {
          hideThinkingStatus();
          toolCalls = tcs;
        },
        onError: (error) => {
          hideThinkingStatus();
          printError(error.message);
        }
      });
    } catch (error: any) {
      hideThinkingStatus();
      printError(error.message);
      break;
    }

    if (!isActive()) break;

    // Handle tool calls
    if (toolCalls && toolCalls.length > 0) {
      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: fullContent,
        tool_calls: toolCalls
      });

      if (fullContent) {
        console.log(); // New line after content
      }

      // Execute each tool
      for (const tc of toolCalls) {
        if (!isActive()) break;

        const args = JSON.parse(tc.function.arguments);
        printToolExecution(tc.function.name, formatToolArgs(tc.function.name, args));

        showThinkingStatus(`Executing ${tc.function.name}`);
        const result = await executeTool(tc.function.name, args);
        hideThinkingStatus();

        printToolResult(result.success, result.result);

        // Add tool result
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.result
        });
      }

      // Continue loop for next response
      continue;
    } else {
      // No tool calls, conversation turn complete
      if (fullContent) {
        messages.push({ role: 'assistant', content: fullContent });
        console.log(); // New line after response
      }
      break;
    }
  }
}

async function handleSlashCommand(
  command: string,
  messages: Message[],
  session: any,
  options: ReplOptions
): Promise<void> {
  const [cmd, ...args] = command.slice(1).split(' ');

  switch (cmd.toLowerCase()) {
    case 'help':
      console.log();
      console.log(chalk.bold('Available commands:'));
      console.log(chalk.cyan('  /help') + chalk.gray('     - Show this help'));
      console.log(chalk.cyan('  /clear') + chalk.gray('    - Clear conversation'));
      console.log(chalk.cyan('  /model') + chalk.gray('    - Switch model'));
      console.log(chalk.cyan('  /context') + chalk.gray('  - Show current context'));
      console.log(chalk.cyan('  /save') + chalk.gray('     - Save conversation'));
      console.log(chalk.cyan('  /exit') + chalk.gray('     - Exit Codea'));
      console.log();
      break;

    case 'clear':
      messages.length = 0;
      console.log(chalk.green('Conversation cleared.'));
      break;

    case 'model':
      const modelArg = args[0];
      if (modelArg) {
        options.model = modelArg.startsWith('alia-') ? modelArg : `alia-v1-${modelArg}`;
        console.log(chalk.green(`Model switched to ${options.model}`));
      } else {
        console.log(chalk.gray('Current model: ') + chalk.cyan(options.model));
        try {
          const { fetchModels } = await import('../utils/api.js');
          const apiModels = await fetchModels();
          if (apiModels.length > 0) {
            console.log(chalk.gray('Available models:'));
            for (const m of apiModels) {
              console.log(chalk.gray('  ') + chalk.cyan(m.id) + chalk.gray(` - ${m.name}`));
            }
          } else {
            console.log(chalk.gray('Available: codea, codea-pro, codea-thinking'));
          }
        } catch {
          console.log(chalk.gray('Available: codea, codea-pro, codea-thinking'));
        }
      }
      break;

    case 'context':
      console.log(chalk.gray(`Messages in context: ${messages.length}`));
      console.log(chalk.gray(`Working directory: ${process.cwd()}`));
      break;

    case 'save':
      session.messages = messages.map(m => ({ role: m.role, content: m.content }));
      session.updatedAt = Date.now();
      saveSession(session);
      console.log(chalk.green('Conversation saved.'));
      break;

    case 'exit':
    case 'quit':
      console.log(chalk.gray('Goodbye!'));
      process.exit(0);
      break;

    default:
      console.log(chalk.yellow(`Unknown command: /${cmd}`));
      console.log(chalk.gray('Type /help for available commands.'));
  }
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

function getModelDisplayName(model: string): string {
  const names: Record<string, string> = {
    'alia-v1-codea': 'codea',
    'alia-v1-pro': 'codea-pro',
    'alia-v1-thinking': 'codea-thinking'
  };
  return names[model] || model;
}
