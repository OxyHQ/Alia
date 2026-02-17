import * as readline from 'readline';
import * as crypto from 'crypto';
import * as http from 'http';
import { exec } from 'child_process';
import chalk from 'chalk';
import { config } from '../utils/config.js';
function printSuccess(message: string): void {
  console.log(chalk.green('✓ ') + message);
}

function printError(message: string): void {
  console.log(chalk.red('✗ Error: ') + message);
}

function printInfo(message: string): void {
  console.log(chalk.blue('ℹ ') + message);
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start ""'
        : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

async function loginWithBrowser(): Promise<boolean> {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error || !code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body style="font-family:system-ui;text-align:center;padding:60px">' +
            '<h2>Authorization cancelled</h2><p>You can close this window.</p></body></html>',
        );
        server.close();
        resolve(false);
        return;
      }

      try {
        const baseUrl = config.get('apiBaseUrl') || 'https://api.alia.onl';
        const response = await fetch(`${baseUrl}/auth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            code_verifier: codeVerifier,
            client_id: 'codea',
          }),
        });

        const data = (await response.json()) as { token?: string };

        if (data.token) {
          config.set('apiKey', data.token);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body style="font-family:system-ui;text-align:center;padding:60px">' +
              '<h2>Logged in!</h2><p>You can close this window and return to the terminal.</p></body></html>',
          );
          console.log();
          printSuccess('Logged in successfully!');
          server.close();
          resolve(true);
        } else {
          throw new Error('No token received');
        }
      } catch {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body style="font-family:system-ui;text-align:center;padding:60px">' +
            '<h2>Login failed</h2><p>Please try again.</p></body></html>',
        );
        printError('Failed to exchange authorization code.');
        server.close();
        resolve(false);
      }
    });

    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const callback = encodeURIComponent(`http://localhost:${port}/callback`);
      const authorizeUrl =
        `https://alia.onl/authorize?app=codea` +
        `&callback=${callback}` +
        `&code_challenge=${codeChallenge}` +
        `&code_challenge_method=S256`;

      printInfo('Opening browser for authorization...');
      openBrowser(authorizeUrl);
      console.log(
        chalk.gray('\nIf the browser doesn\'t open, visit:\n') +
          chalk.cyan(authorizeUrl) +
          '\n',
      );
      console.log(chalk.gray('Waiting for authorization...'));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      printError('Authorization timed out.');
      resolve(false);
    }, 5 * 60 * 1000);
  });
}

async function loginWithApiKey(): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(chalk.cyan('API Key: '), async (apiKey) => {
      rl.close();

      const trimmedKey = apiKey.trim();
      if (!trimmedKey) {
        printError('No API key provided.');
        resolve(false);
        return;
      }

      printInfo('Validating API key...');

      try {
        const baseUrl = config.get('apiBaseUrl') || 'https://api.alia.onl';
        const response = await fetch(`${baseUrl}/codea/me`, {
          headers: { Authorization: `Bearer ${trimmedKey}` },
        });

        if (response.ok) {
          const data = (await response.json()) as { name?: string };
          config.set('apiKey', trimmedKey);
          console.log();
          printSuccess('Logged in successfully!');
          if (data.name) {
            console.log(chalk.gray(`Welcome, ${data.name}!`));
          }
          resolve(true);
        } else {
          printError('Invalid API key. Please check and try again.');
          resolve(false);
        }
      } catch (error: any) {
        printError(`Could not validate API key: ${error.message}`);
        resolve(false);
      }
    });
  });
}

export async function login(): Promise<boolean> {
  console.log();
  console.log(chalk.bold('Codea CLI Login'));
  console.log();

  const success = await loginWithBrowser();
  if (success) return true;

  // Fallback to manual API key entry
  console.log();
  console.log(
    chalk.gray('Alternatively, paste your API key from: ') +
      chalk.cyan('https://alia.onl/settings/api'),
  );
  console.log();
  return loginWithApiKey();
}

export function logout(): void {
  config.delete('apiKey');
  printSuccess('Logged out successfully.');
}
