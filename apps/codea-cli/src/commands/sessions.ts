import chalk from 'chalk';
import * as readline from 'readline';
import { getSessions, getSession, config } from '../utils/config.js';
import { startRepl } from './repl.js';
import { printBanner, printError, printInfo } from '../utils/ui.js';

export async function listSessions(): Promise<void> {
  const sessions = getSessions();

  if (sessions.length === 0) {
    printInfo('No saved sessions found.');
    console.log(chalk.gray('Start a new session with: ') + chalk.cyan('codea'));
    return;
  }

  console.log();
  console.log(chalk.bold('Recent Sessions'));
  console.log(chalk.gray('─'.repeat(60)));

  sessions.slice(0, 10).forEach((session, index) => {
    const date = new Date(session.updatedAt).toLocaleDateString();
    const time = new Date(session.updatedAt).toLocaleTimeString();
    const messageCount = session.messages?.length || 0;
    const title = session.title.slice(0, 40) + (session.title.length > 40 ? '...' : '');

    console.log(
      chalk.cyan(`${index + 1}.`) + ' ' +
      chalk.white(title) + ' ' +
      chalk.gray(`(${messageCount} msgs, ${date} ${time})`)
    );
  });

  console.log();
  console.log(chalk.gray('Resume a session with: ') + chalk.cyan('codea resume <number>'));
}

export async function resumeSession(sessionId?: string): Promise<void> {
  const sessions = getSessions();

  if (sessions.length === 0) {
    printInfo('No saved sessions found.');
    return;
  }

  let selectedSession;

  if (sessionId) {
    // Try to find by index (1-based) or ID
    const index = parseInt(sessionId) - 1;
    if (!isNaN(index) && index >= 0 && index < sessions.length) {
      selectedSession = sessions[index];
    } else {
      selectedSession = getSession(sessionId);
    }

    if (!selectedSession) {
      printError(`Session not found: ${sessionId}`);
      return;
    }
  } else {
    // Show picker
    console.log();
    console.log(chalk.bold('Select a session to resume:'));
    console.log();

    sessions.slice(0, 10).forEach((session, index) => {
      const date = new Date(session.updatedAt).toLocaleDateString();
      const title = session.title.slice(0, 50) + (session.title.length > 50 ? '...' : '');
      console.log(chalk.cyan(`  ${index + 1}.`) + ' ' + title + ' ' + chalk.gray(`(${date})`));
    });

    console.log();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question(chalk.cyan('Enter number: '), (answer) => {
        rl.close();

        const index = parseInt(answer) - 1;
        if (isNaN(index) || index < 0 || index >= sessions.length) {
          printError('Invalid selection.');
          resolve();
          return;
        }

        selectedSession = sessions[index];
        startRestoredSession(selectedSession).then(resolve);
      });
    });
  }

  if (selectedSession) {
    await startRestoredSession(selectedSession);
  }
}

async function startRestoredSession(session: any): Promise<void> {
  printInfo(`Resuming: ${session.title}`);
  console.log();

  // Display previous messages
  for (const msg of session.messages || []) {
    if (msg.role === 'user') {
      console.log(chalk.cyan('❯ ') + msg.content);
    } else if (msg.role === 'assistant') {
      console.log(chalk.magenta('✦ ') + msg.content.slice(0, 200) + (msg.content.length > 200 ? '...' : ''));
    }
    console.log();
  }

  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.gray('Session restored. Continue the conversation below.'));
  console.log();

  // Start REPL with restored session
  const model = config.get('defaultModel') || 'alia-v1-codea';
  await startRepl({ model, context: true });
}
