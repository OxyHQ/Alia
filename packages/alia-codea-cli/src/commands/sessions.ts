import chalk from 'chalk';
import * as readline from 'readline';
import { getSessions, getSession, config, Session } from '../utils/config.js';
import { startRepl } from './repl.js';

export async function listSessions(): Promise<void> {
  const sessions = getSessions();

  if (sessions.length === 0) {
    console.log(chalk.blue('ℹ ') + 'No saved sessions found.');
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
    console.log(chalk.blue('ℹ ') + 'No saved sessions found.');
    return;
  }

  let session: Session | undefined;

  if (sessionId) {
    const index = parseInt(sessionId, 10) - 1;
    if (!isNaN(index) && index >= 0 && index < sessions.length) {
      session = sessions[index];
    } else {
      session = getSession(sessionId);
    }

    if (!session) {
      console.log(chalk.red('✗ Error: ') + `Session not found: ${sessionId}`);
      return;
    }
  } else {
    session = await promptSessionPicker(sessions);
    if (!session) return;
  }

  await startRestoredSession(session);
}

function promptSessionPicker(sessions: Session[]): Promise<Session | undefined> {
  console.log();
  console.log(chalk.bold('Select a session to resume:'));
  console.log();

  sessions.slice(0, 10).forEach((s, index) => {
    const date = new Date(s.updatedAt).toLocaleDateString();
    const title = s.title.slice(0, 50) + (s.title.length > 50 ? '...' : '');
    console.log(chalk.cyan(`  ${index + 1}.`) + ' ' + title + ' ' + chalk.gray(`(${date})`));
  });

  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(chalk.cyan('Enter number: '), (answer) => {
      rl.close();
      const index = parseInt(answer, 10) - 1;
      if (isNaN(index) || index < 0 || index >= sessions.length) {
        console.log(chalk.red('✗ Error: ') + 'Invalid selection.');
        resolve(undefined);
        return;
      }
      resolve(sessions[index]);
    });
  });
}

async function startRestoredSession(session: Session): Promise<void> {
  console.log(chalk.blue('ℹ ') + `Resuming: ${session.title}`);
  console.log();

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

  const model = config.get('defaultModel') || 'alia-v1-codea';
  await startRepl({ model, context: true });
}
