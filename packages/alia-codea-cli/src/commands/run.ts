import chalk from 'chalk';
import * as readline from 'readline';
import { buildSystemMessage, getCodebaseContext, loadProjectInstructions } from '../utils/context.js';
import { processConversation, Message, ToolExecution } from '../utils/conversation.js';
import { parseApprovalMode } from '../utils/approval.js';
import { formatToolArgs } from '../utils/format.js';

interface RunOptions {
  model: string;
  yes: boolean;
  context: boolean;
  approvalMode?: string;
  quiet?: boolean;
  json?: boolean;
}

interface JsonOutput {
  model: string;
  prompt: string;
  response: string;
  tool_calls: Array<{ tool: string; args: Record<string, unknown>; result: string; success: boolean }>;
}

export async function runPrompt(prompt: string, options: RunOptions): Promise<void> {
  const messages: Message[] = [];
  const toolResults: JsonOutput['tool_calls'] = [];

  let codebaseContext = '';
  if (options.context !== false) {
    codebaseContext = await getCodebaseContext();
  }

  const instructions = await loadProjectInstructions();

  messages.push({ role: 'user', content: prompt });

  const systemMessage = buildSystemMessage(codebaseContext, instructions);

  const approvalMode = options.yes
    ? 'full-auto' as const
    : parseApprovalMode(options.approvalMode);

  let fullResponse = '';
  let active = true;

  process.once('SIGINT', () => { active = false; });

  await processConversation({
    messages,
    systemMessage,
    model: options.model,
    approvalMode,
    isActive: () => active,
    requestApproval: async (execution) => {
      if (options.quiet || options.json) return false;
      return askApproval(execution);
    },
    onEvent: (event) => {
      switch (event.type) {
        case 'thinking':
          if (!options.quiet && !options.json) {
            process.stdout.write(chalk.magenta('✦ '));
          }
          break;
        case 'content':
          fullResponse += event.text;
          if (!options.quiet && !options.json) {
            process.stdout.write(event.text);
          }
          break;
        case 'tool_start':
          if (!options.quiet && !options.json) {
            console.log();
            console.log(chalk.cyan('  → ') + chalk.bold(event.execution.tool) + ' ' + chalk.gray(formatToolArgs(event.execution.tool, event.execution.args)));
          }
          break;
        case 'tool_done':
          if (event.execution.result !== undefined) {
            toolResults.push({
              tool: event.execution.tool,
              args: event.execution.args,
              result: event.execution.result,
              success: event.execution.success ?? false,
            });
          }
          if (!options.quiet && !options.json) {
            const icon = event.execution.success ? chalk.green('  ✓') : chalk.red('  ✗');
            const preview = (event.execution.result || '').slice(0, 100).replace(/\n/g, ' ');
            console.log(`${icon} ${chalk.gray(preview)}`);
          }
          break;
        case 'done':
          if (!options.quiet && !options.json) {
            console.log();
          }
          break;
        case 'error':
          if (!options.json) {
            console.error(chalk.red('Error: ') + event.message);
          }
          break;
      }
    },
  });

  if (options.json) {
    const output: JsonOutput = {
      model: options.model,
      prompt,
      response: fullResponse,
      tool_calls: toolResults,
    };
    console.log(JSON.stringify(output, null, 2));
  } else if (options.quiet) {
    if (fullResponse) {
      console.log(fullResponse);
    }
  }
}

async function askApproval(execution: ToolExecution): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const desc = formatToolArgs(execution.tool, execution.args);
  console.log();
  console.log(chalk.yellow('⚠ ') + chalk.bold(execution.tool) + ' ' + desc);

  return new Promise((resolve) => {
    rl.question(chalk.cyan('  Allow? [y/N] '), (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
