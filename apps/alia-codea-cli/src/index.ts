#!/usr/bin/env node

import { Command } from 'commander';
import { config } from './utils/config.js';
import { startRepl } from './commands/repl.js';
import { runPrompt } from './commands/run.js';
import { login } from './commands/auth.js';
import { listSessions, resumeSession } from './commands/sessions.js';
import chalk from 'chalk';

const VERSION = '1.0.0';

const program = new Command();

// ASCII art banner
const banner = `
${chalk.cyan('   ____          _            ')}
${chalk.cyan('  / ___|___   __| | ___  __ _ ')}
${chalk.cyan(' | |   / _ \\ / _\` |/ _ \\/ _\` |')}
${chalk.cyan(' | |__| (_) | (_| |  __/ (_| |')}
${chalk.cyan('  \\____\\___/ \\__,_|\\___|\\__,_|')}
${chalk.gray('  AI Coding Assistant by Alia')}
`;

program
  .name('codea')
  .description('Codea CLI - AI coding assistant for your terminal')
  .version(VERSION)
  .hook('preAction', async () => {
    const command = program.args[0];
    if (command === 'login' || command === 'help') return;

    if (!config.get('apiKey')) {
      console.log(banner);
      console.log(chalk.yellow('No API key found. Let\'s get you logged in.\n'));
      const success = await login();
      if (!success) {
        process.exit(1);
      }
      console.log();
    }
  });

// Default command - start REPL
program
  .command('chat', { isDefault: true })
  .description('Start an interactive chat session')
  .option('-m, --model <model>', 'Model to use (codea, codea-pro, codea-thinking)', 'alia-v1-codea')
  .option('--no-context', 'Disable automatic codebase context')
  .action(async (options) => {
    console.log(banner);
    await startRepl(options);
  });

// Run a single prompt
program
  .command('run <prompt>')
  .alias('r')
  .description('Run a single prompt and exit')
  .option('-m, --model <model>', 'Model to use', 'alia-v1-codea')
  .option('-y, --yes', 'Auto-approve all file changes')
  .option('--no-context', 'Disable automatic codebase context')
  .action(async (prompt, options) => {
    await runPrompt(prompt, options);
  });

// Login/configure
program
  .command('login')
  .description('Configure your Alia API key')
  .action(async () => {
    await login();
  });

// Session management
program
  .command('sessions')
  .alias('s')
  .description('List recent chat sessions')
  .action(async () => {
    await listSessions();
  });

program
  .command('resume [sessionId]')
  .description('Resume a previous chat session')
  .action(async (sessionId) => {
    console.log(banner);
    await resumeSession(sessionId);
  });

// Parse and run
program.parse();
